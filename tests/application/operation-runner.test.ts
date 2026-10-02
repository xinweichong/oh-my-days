import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  CREATE_EVENT,
  type CreateEventIntent,
  PATCH_EVENT,
  type PatchEventIntent,
} from "../../src/application/event-operations";
import {
  OPERATION_LEASE_MS,
  OPERATION_MAX_ATTEMPTS,
  runDueOperations,
} from "../../src/application/operation-runner";
import type { UserRecord } from "../../src/storage/users";
import { OTHER_USER, OWNER } from "../support/fakes";
import {
  at,
  CAL,
  calendarOf,
  createUser,
  dinner,
  type Harness,
  harness,
  messages,
  operationRow,
  submit,
} from "../support/operations";

async function proposeCreate(h: Harness, user: UserRecord, eventId = "evt1") {
  const intent: CreateEventIntent = { calendarId: CAL, eventId, fields: dinner() };
  return submit(h, user, {
    kind: CREATE_EVENT,
    idempotencyKey: `create:${eventId}`,
    intent,
    confirmation: null,
  });
}

async function proposeMoveTo(h: Harness, user: UserRecord, hour: number, key = "move") {
  const intent: PatchEventIntent = {
    calendarId: CAL,
    eventId: "evt1",
    title: "Dinner",
    base: { start: dinner().start, end: dinner().end },
    patch: { start: at(hour), end: at(hour + 1) },
  };
  return submit(h, user, { kind: PATCH_EVENT, idempotencyKey: key, intent, confirmation: null });
}

/** Advances past any backoff and runs everything due. */
async function runLater(h: Harness, ms = 60 * 60_000): Promise<number> {
  h.clock.advance(ms);
  return runDueOperations(h, 10);
}

describe("operation runner", () => {
  it("executes a clear create immediately and reports the exact result with Undo", async () => {
    const h = harness(env.DB);
    const owner = await createUser(h, OWNER);
    const { operationId } = await proposeCreate(h, owner);

    expect(await runDueOperations(h, 10)).toBe(1);

    expect(calendarOf(h, owner).live(CAL, "evt1")?.fields.summary).toBe("Dinner");
    expect((await operationRow(env.DB, operationId)).status).toBe("succeeded");
    const [message] = await messages(env.DB, owner.id);
    expect(message?.text).toBe("Event added: Dinner\nFri 25 Sep 2026, 7–8pm");
    expect(message?.buttons.map((b) => b.text)).toEqual(["Undo"]);
  });

  it("sends one pending notice across retries, then one result", async () => {
    const h = harness(env.DB);
    const owner = await createUser(h, OWNER);
    const unavailable = { kind: "retryable", retryAfterMs: null } as const;
    calendarOf(h, owner)
      .inject({ method: "insert", mode: "error", error: unavailable })
      .inject({ method: "insert", mode: "error", error: unavailable })
      .inject({ method: "insert", mode: "error", error: unavailable });
    const { operationId } = await proposeCreate(h, owner);

    await runDueOperations(h, 10);
    expect((await operationRow(env.DB, operationId)).status).toBe("retry_wait");
    expect(await runDueOperations(h, 10)).toBe(0); // backoff not yet elapsed
    await runLater(h);
    await runLater(h);
    await runLater(h);

    expect((await messages(env.DB, owner.id)).map((m) => m.text)).toEqual([
      "Pending: Dinner has not been added to Google Calendar. I'll retry automatically.",
      "Event added: Dinner\nFri 25 Sep 2026, 7–8pm",
    ]);
    expect(calendarOf(h, owner).events.size).toBe(1);
  });

  it("does not duplicate a create whose response was lost", async () => {
    const h = harness(env.DB);
    const owner = await createUser(h, OWNER);
    calendarOf(h, owner).inject({ method: "insert", mode: "apply_then_unknown" });
    const { operationId } = await proposeCreate(h, owner);

    await runDueOperations(h, 10);
    expect(await operationRow(env.DB, operationId)).toMatchObject({
      status: "retry_wait",
      outcome_unknown: 1,
    });
    await runLater(h);

    expect(calendarOf(h, owner).events.size).toBe(1);
    expect((await operationRow(env.DB, operationId)).status).toBe("succeeded");
    const texts = (await messages(env.DB, owner.id)).map((m) => m.text);
    expect(texts[0]).toContain("couldn't confirm that Dinner was added");
    expect(texts[1]).toContain("Event added: Dinner");
  });

  it("reconciles after a worker crash following the provider write", async () => {
    const h = harness(env.DB);
    const owner = await createUser(h, OWNER);
    calendarOf(h, owner).inject({ method: "insert", mode: "apply_then_throw" });
    const { operationId } = await proposeCreate(h, owner);

    await runDueOperations(h, 10);
    expect((await operationRow(env.DB, operationId)).outcome_unknown).toBe(1);
    await runLater(h);

    expect(calendarOf(h, owner).events.size).toBe(1);
    expect((await operationRow(env.DB, operationId)).status).toBe("succeeded");
  });

  it("reclaims an operation whose worker vanished mid-attempt as an unknown outcome", async () => {
    const h = harness(env.DB);
    const owner = await createUser(h, OWNER);
    const { operationId } = await proposeCreate(h, owner);
    // Simulate a worker that claimed the operation, wrote to Google, and died.
    await env.DB.prepare(
      "UPDATE operations SET status = 'applying', attempts = 1, lease_token = 'dead', lease_expires_at = ? WHERE id = ?",
    )
      .bind(h.clock.now() + OPERATION_LEASE_MS, operationId)
      .run();
    calendarOf(h, owner).seed(CAL, "evt1", dinner());

    expect(await runDueOperations(h, 10)).toBe(0); // lease still live
    h.clock.advance(OPERATION_LEASE_MS + 1);
    await runDueOperations(h, 10);

    expect(calendarOf(h, owner).events.size).toBe(1);
    expect(await operationRow(env.DB, operationId)).toMatchObject({
      status: "succeeded",
      attempts: 2,
    });
  });

  it("recovers from a crash before the side effect without losing the request", async () => {
    const h = harness(env.DB);
    const owner = await createUser(h, OWNER);
    calendarOf(h, owner).inject({
      method: "insert",
      mode: "error",
      error: { kind: "retryable", retryAfterMs: 5_000 },
    });
    await proposeCreate(h, owner);

    await runDueOperations(h, 10);
    expect(calendarOf(h, owner).events.size).toBe(0);
    await runLater(h);
    expect(calendarOf(h, owner).events.size).toBe(1);
  });

  it("asks instead of overwriting a same-field external edit", async () => {
    const h = harness(env.DB);
    const owner = await createUser(h, OWNER);
    const calendar = calendarOf(h, owner);
    calendar.seed(CAL, "evt1", dinner());
    const { operationId } = await proposeMoveTo(h, owner, 16);
    calendar.externalEdit(CAL, "evt1", { start: at(17), end: at(18) });

    await runDueOperations(h, 10);

    expect(calendar.live(CAL, "evt1")?.fields.start).toEqual(at(17));
    expect(await operationRow(env.DB, operationId)).toMatchObject({
      status: "needs_resolution",
      error_class: "field_conflict",
    });
    expect((await messages(env.DB, owner.id))[0]?.text).toBe(
      "Dinner changed in Calendar while your change was pending. Nothing was overwritten.",
    );
  });

  it("applies an edit without overwriting unrelated external changes", async () => {
    const h = harness(env.DB);
    const owner = await createUser(h, OWNER);
    const calendar = calendarOf(h, owner);
    calendar.seed(CAL, "evt1", dinner());
    await proposeMoveTo(h, owner, 16);
    calendar.externalEdit(CAL, "evt1", { summary: "Dinner with the team" });

    await runDueOperations(h, 10);

    const event = calendar.live(CAL, "evt1");
    expect(event?.fields.summary).toBe("Dinner with the team");
    expect(event?.fields.start).toEqual(at(16));
  });

  it("does not repeat an edit whose response was lost", async () => {
    const h = harness(env.DB);
    const owner = await createUser(h, OWNER);
    const calendar = calendarOf(h, owner);
    calendar.seed(CAL, "evt1", dinner());
    calendar.inject({ method: "patch", mode: "apply_then_unknown" });
    const { operationId } = await proposeMoveTo(h, owner, 16);

    await runDueOperations(h, 10);
    await runLater(h);

    expect(calendar.calls.filter((c) => c === "patch")).toHaveLength(1);
    expect((await operationRow(env.DB, operationId)).status).toBe("succeeded");
  });

  it("re-reads and retries when the version moves between read and write", async () => {
    const h = harness(env.DB);
    const owner = await createUser(h, OWNER);
    const calendar = calendarOf(h, owner);
    calendar.seed(CAL, "evt1", dinner());
    calendar.inject({ method: "patch", mode: "error", error: { kind: "conflict" } });
    const { operationId } = await proposeMoveTo(h, owner, 16);

    await runDueOperations(h, 10);
    expect((await operationRow(env.DB, operationId)).status).toBe("retry_wait");
    await runLater(h);
    expect(calendar.live(CAL, "evt1")?.fields.start).toEqual(at(16));
  });

  it("reports reconnection is required when there is no Google connection", async () => {
    const h = harness(env.DB);
    const owner = await createUser(h, OWNER, false);
    const { operationId } = await proposeCreate(h, owner);

    await runDueOperations(h, 10);

    expect((await operationRow(env.DB, operationId)).status).toBe("auth_required");
    expect((await messages(env.DB, owner.id))[0]?.text).toBe(
      "Google Calendar needs to be reconnected before I can add Dinner. Nothing has changed yet.",
    );
  });

  it("explains a read-only calendar instead of implying success", async () => {
    const h = harness(env.DB);
    const owner = await createUser(h, OWNER);
    calendarOf(h, owner).readOnlyCalendars.add(CAL);
    const { operationId } = await proposeCreate(h, owner);

    await runDueOperations(h, 10);

    expect((await operationRow(env.DB, operationId)).status).toBe("failed");
    expect((await messages(env.DB, owner.id))[0]?.text).toContain("doesn't allow changes");
  });

  it("stops after the maximum attempts and asks for attention", async () => {
    const h = harness(env.DB);
    const owner = await createUser(h, OWNER);
    for (let i = 0; i < OPERATION_MAX_ATTEMPTS; i++) {
      calendarOf(h, owner).inject({
        method: "insert",
        mode: "error",
        error: { kind: "retryable", retryAfterMs: null },
      });
    }
    const { operationId } = await proposeCreate(h, owner);

    await runDueOperations(h, 10);
    for (let i = 1; i < OPERATION_MAX_ATTEMPTS; i++) await runLater(h);

    expect(await operationRow(env.DB, operationId)).toMatchObject({
      status: "needs_resolution",
      error_class: "retries_exhausted",
      attempts: OPERATION_MAX_ATTEMPTS,
    });
    expect(await runLater(h)).toBe(0);
  });

  it("uses only the owning user's calendar and runs only their operations when scoped", async () => {
    const h = harness(env.DB);
    const owner = await createUser(h, OWNER);
    const other = await createUser(h, OTHER_USER);
    await proposeCreate(h, owner, "evtowner");
    await proposeCreate(h, other, "evtother");

    expect(await runDueOperations(h, 10, owner.id)).toBe(1);
    expect(calendarOf(h, owner).live(CAL, "evtowner")).not.toBeNull();
    expect(calendarOf(h, other).events.size).toBe(0);

    await runDueOperations(h, 10);
    expect(calendarOf(h, other).live(CAL, "evtother")).not.toBeNull();
    expect(calendarOf(h, owner).live(CAL, "evtother")).toBeNull();
  });

  it("returns the existing operation for a repeated idempotency key", async () => {
    const h = harness(env.DB);
    const owner = await createUser(h, OWNER);
    await proposeCreate(h, owner);
    await proposeCreate(h, owner);
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM operations").first<{ n: number }>();
    expect(row?.n).toBe(1);
  });
});
