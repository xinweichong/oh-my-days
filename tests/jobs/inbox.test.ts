import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { INBOX_LEASE_MS, INBOX_MAX_ATTEMPTS, processUserInbox } from "../../src/jobs/inbox";
import { claimNextUpdate } from "../../src/storage/inbox";
import { createUpdateHandler, type UpdateHandler } from "../../src/telegram/router";
import { count, rows } from "../support/db";
import { FakeClock, OTHER_USER, OWNER, SequentialIds } from "../support/fakes";
import { acceptUpdate, callbackUpdate, textUpdate, userIdFor } from "../support/telegram";

function deps(handler: UpdateHandler = createUpdateHandler()) {
  return { db: env.DB, clock: new FakeClock(), ids: new SequentialIds(), handler };
}

async function outboxTexts(userId: string): Promise<string[]> {
  const list = await rows<{ payload: string }>(
    env.DB,
    "SELECT payload FROM telegram_outbox WHERE user_id = ? ORDER BY rowid",
    userId,
  );
  return list.map((r) => (JSON.parse(r.payload) as { text?: string }).text ?? "");
}

describe("inbox processing", () => {
  it("processes a user's updates in order and clears stored message content", async () => {
    const d = deps();
    await acceptUpdate(env.DB, textUpdate(OWNER, "/help"), d.clock.now(), d.ids);
    await acceptUpdate(env.DB, textUpdate(OWNER, "/start"), d.clock.now(), d.ids);
    const owner = await userIdFor(env.DB, OWNER);

    expect(await processUserInbox(d, owner, 10)).toBe(2);

    const texts = await outboxTexts(owner);
    expect(texts[0]).toContain("Available commands");
    expect(texts[1]).toContain("A little less to keep in your head.");
    expect(await count(env.DB, "telegram_inbox", "payload IS NOT NULL")).toBe(0);
  });

  it("answers unsupported input factually", async () => {
    const d = deps();
    const photo = textUpdate(OWNER, "") as { message: Record<string, unknown> };
    delete photo.message.text;
    await acceptUpdate(env.DB, photo, d.clock.now(), d.ids);
    await acceptUpdate(env.DB, textUpdate(OWNER, "Dinner Friday at 7pm"), d.clock.now(), d.ids);
    await acceptUpdate(env.DB, callbackUpdate(OWNER, "stale"), d.clock.now(), d.ids);
    const owner = await userIdFor(env.DB, OWNER);

    await processUserInbox(d, owner, 10);

    const calls = await rows<{ method: string; payload: string }>(
      env.DB,
      "SELECT method, payload FROM telegram_outbox ORDER BY rowid",
    );
    expect(calls.map((c) => c.method)).toEqual([
      "sendMessage",
      "sendMessage",
      "answerCallbackQuery",
    ]);
    expect(calls[0]?.payload).toContain("only read text");
    expect(calls[1]?.payload).toContain("isn't available yet");
    expect(calls[2]?.payload).toContain("no longer valid");
  });

  it("serializes one user's updates but lets other users proceed", async () => {
    const d = deps();
    await acceptUpdate(env.DB, textUpdate(OWNER, "/help"), d.clock.now(), d.ids);
    await acceptUpdate(env.DB, textUpdate(OWNER, "/start"), d.clock.now(), d.ids);
    await acceptUpdate(env.DB, textUpdate(OTHER_USER, "/help"), d.clock.now(), d.ids);
    const owner = await userIdFor(env.DB, OWNER);
    const other = await userIdFor(env.DB, OTHER_USER);

    const first = await claimNextUpdate(env.DB, owner, "lease-a", d.clock.now(), INBOX_LEASE_MS);
    expect(first).not.toBeNull();
    expect(
      await claimNextUpdate(env.DB, owner, "lease-b", d.clock.now(), INBOX_LEASE_MS),
    ).toBeNull();
    const otherClaim = await claimNextUpdate(env.DB, other, "lease-c", d.clock.now(), 1000);
    expect(otherClaim?.userId).toBe(other);
  });

  it("never processes another user's update", async () => {
    const d = deps();
    await acceptUpdate(env.DB, textUpdate(OTHER_USER, "/help"), d.clock.now(), d.ids);
    await acceptUpdate(env.DB, textUpdate(OWNER, "/start"), d.clock.now(), d.ids);
    const owner = await userIdFor(env.DB, OWNER);

    expect(await processUserInbox(d, owner, 10)).toBe(1);
    expect(await count(env.DB, "telegram_inbox", "status = 'pending'")).toBe(1);
    expect(await count(env.DB, "telegram_outbox", `user_id <> '${owner}'`)).toBe(0);
  });

  it("discards the results of a worker whose lease expired and was reclaimed", async () => {
    const d = deps();
    await acceptUpdate(env.DB, textUpdate(OWNER, "/help"), d.clock.now(), d.ids);
    const owner = await userIdFor(env.DB, OWNER);

    // A slow worker claims the update, then stalls past its lease.
    let release: () => void = () => {};
    const stalled = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slowHandler: UpdateHandler = async (user, update) => {
      await stalled;
      return createUpdateHandler()(user, update);
    };
    const slow = processUserInbox({ ...d, handler: slowHandler }, owner, 1);

    await new Promise((r) => setTimeout(r, 10));
    d.clock.advance(INBOX_LEASE_MS + 1);
    expect(await processUserInbox(d, owner, 1)).toBe(1);

    release();
    expect(await slow).toBe(0);
    expect(await count(env.DB, "telegram_outbox")).toBe(1);
  });

  it("retries after a handler error, then gives up and tells the user", async () => {
    const failing: UpdateHandler = async () => {
      throw new Error("boom");
    };
    const d = deps(failing);
    await acceptUpdate(env.DB, textUpdate(OWNER, "/help"), d.clock.now(), d.ids);
    const owner = await userIdFor(env.DB, OWNER);

    for (let attempt = 1; attempt <= INBOX_MAX_ATTEMPTS; attempt++) {
      expect(await processUserInbox(d, owner, 1)).toBe(0);
      expect(await count(env.DB, "telegram_outbox")).toBe(0);
      d.clock.advance(INBOX_LEASE_MS + 1);
    }
    expect(await processUserInbox(d, owner, 1)).toBe(1);

    const [row] = await rows<{ status: string }>(env.DB, "SELECT status FROM telegram_inbox");
    expect(row?.status).toBe("failed");
    expect(await outboxTexts(owner)).toEqual([
      "I couldn't process that message. Please send it again.",
    ]);
  });
});
