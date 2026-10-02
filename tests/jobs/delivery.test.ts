import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { DELIVERY_LEASE_MS, DELIVERY_MAX_ATTEMPTS, deliverDue } from "../../src/jobs/delivery";
import { unguarded } from "../../src/storage/guard";
import {
  claimNextDelivery,
  enqueueStatement,
  recoverExpiredDeliveries,
} from "../../src/storage/outbox";
import { upsertUserStatement } from "../../src/storage/users";
import type { TelegramCall } from "../../src/telegram/api";
import { rows } from "../support/db";
import { FakeClock, FakeTelegram, OTHER_USER, OWNER, SequentialIds } from "../support/fakes";
import { userIdFor } from "../support/telegram";

function setup() {
  const clock = new FakeClock();
  const ids = new SequentialIds();
  const telegram = new FakeTelegram();
  return { db: env.DB, clock, ids, telegram, random: () => 0.5 };
}

type Deps = ReturnType<typeof setup>;

async function userWithMessages(d: Deps, telegramId: number, calls: TelegramCall[]) {
  await upsertUserStatement(d.db, d.ids, telegramId, telegramId, d.clock.now()).run();
  const userId = await userIdFor(d.db, telegramId);
  await d.db.batch(
    calls.map((call, i) =>
      enqueueStatement(
        d.db,
        d.ids,
        userId,
        { logicalKey: `k${i}`, call },
        d.clock.now(),
        unguarded,
      ),
    ),
  );
  return userId;
}

const send = (text: string): TelegramCall => ({
  method: "sendMessage",
  params: { chat_id: OWNER, text },
});
const answer: TelegramCall = {
  method: "answerCallbackQuery",
  params: { callback_query_id: "q1" },
};

async function statuses() {
  return rows<{
    status: string;
    due_at: number;
    provider_message_id: number | null;
    payload: string | null;
  }>(
    env.DB,
    "SELECT status, due_at, provider_message_id, payload FROM telegram_outbox ORDER BY rowid",
  );
}

describe("outbox delivery", () => {
  it("sends due messages in order and records the Telegram message ID", async () => {
    const d = setup();
    await userWithMessages(d, OWNER, [send("one"), send("two")]);
    expect(await deliverDue(d, 10)).toBe(2);
    expect(d.telegram.texts()).toEqual(["one", "two"]);
    expect(await statuses()).toEqual([
      expect.objectContaining({ status: "sent", provider_message_id: 500, payload: null }),
      expect.objectContaining({ status: "sent", provider_message_id: 501, payload: null }),
    ]);
  });

  it("does not enqueue the same logical message twice", async () => {
    const d = setup();
    const userId = await userWithMessages(d, OWNER, [send("one")]);
    await enqueueStatement(
      d.db,
      d.ids,
      userId,
      { logicalKey: "k0", call: send("again") },
      0,
      unguarded,
    ).run();
    expect(await deliverDue(d, 10)).toBe(1);
    expect(d.telegram.texts()).toEqual(["one"]);
  });

  it("waits at least as long as Telegram's retry_after hint", async () => {
    const d = setup();
    d.telegram.willReturn({ kind: "retryable", retryAfterMs: 30_000, errorClass: "rate_limited" });
    await userWithMessages(d, OWNER, [send("one")]);
    await deliverDue(d, 10);
    const [row] = await statuses();
    expect(row?.status).toBe("pending");
    expect(row?.due_at).toBeGreaterThanOrEqual(d.clock.now() + 30_000);
    expect(await deliverDue(d, 10)).toBe(0); // not yet due
  });

  it("marks a sendMessage with an unknown outcome instead of resending it", async () => {
    const d = setup();
    d.telegram.willReturn({ kind: "unknown", errorClass: "timeout" });
    await userWithMessages(d, OWNER, [send("one")]);
    await deliverDue(d, 10);
    d.clock.advance(60 * 60_000);
    expect(await deliverDue(d, 10)).toBe(0);
    expect((await statuses())[0]?.status).toBe("unknown");
    expect(d.telegram.calls).toHaveLength(1);
  });

  it("retries replay-safe calls after an unknown outcome", async () => {
    const d = setup();
    d.telegram.willReturn({ kind: "unknown", errorClass: "timeout" });
    await userWithMessages(d, OWNER, [answer]);
    await deliverDue(d, 10);
    d.clock.advance(60_000);
    await deliverDue(d, 10);
    expect(d.telegram.calls).toHaveLength(2);
    expect((await statuses())[0]?.status).toBe("sent");
  });

  it("gives up after the maximum number of attempts", async () => {
    const d = setup();
    for (let i = 0; i < DELIVERY_MAX_ATTEMPTS; i++) {
      d.telegram.willReturn({ kind: "retryable", retryAfterMs: null, errorClass: "http_502" });
    }
    await userWithMessages(d, OWNER, [send("one")]);
    for (let i = 0; i < DELIVERY_MAX_ATTEMPTS; i++) {
      await deliverDue(d, 10);
      d.clock.advance(10 * 60_000);
    }
    expect((await statuses())[0]?.status).toBe("failed");
    expect(d.telegram.calls).toHaveLength(DELIVERY_MAX_ATTEMPTS);
  });

  it("fails permanently rejected calls without retrying", async () => {
    const d = setup();
    d.telegram.willReturn({ kind: "permanent", errorClass: "http_403" });
    await userWithMessages(d, OWNER, [send("one")]);
    await deliverDue(d, 10);
    d.clock.advance(60_000);
    expect(await deliverDue(d, 10)).toBe(0);
    expect((await statuses())[0]?.status).toBe("failed");
  });

  it("treats a send abandoned mid-flight as unknown, but re-queues replay-safe calls", async () => {
    const d = setup();
    await userWithMessages(d, OWNER, [send("one")]);
    await userWithMessages(d, OTHER_USER, [answer]);
    await claimNextDelivery(d.db, "crashed-1", d.clock.now(), DELIVERY_LEASE_MS, null);
    await claimNextDelivery(d.db, "crashed-2", d.clock.now(), DELIVERY_LEASE_MS, null);

    d.clock.advance(DELIVERY_LEASE_MS + 1);
    expect(await recoverExpiredDeliveries(d.db, d.clock.now())).toBe(2);
    const list = await statuses();
    expect(list.map((r) => r.status)).toEqual(["unknown", "pending"]);
  });

  it("keeps each user's messages in order while one is in flight", async () => {
    const d = setup();
    const owner = await userWithMessages(d, OWNER, [send("one"), send("two")]);
    const claim = await claimNextDelivery(d.db, "lease", d.clock.now(), DELIVERY_LEASE_MS, owner);
    expect(claim?.call).toEqual(send("one"));
    expect(
      await claimNextDelivery(d.db, "lease-2", d.clock.now(), DELIVERY_LEASE_MS, owner),
    ).toBeNull();
  });
});
