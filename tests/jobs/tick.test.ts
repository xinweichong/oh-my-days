import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { tickDeps } from "../../src/app";
import { FINISHED_RETENTION_MS, runTick, TICK_LIMITS } from "../../src/jobs/tick";
import { count } from "../support/db";
import {
  FakeClock,
  FakeTelegram,
  OTHER_USER,
  OWNER,
  SequentialIds,
  testServices,
} from "../support/fakes";
import { acceptUpdate, textUpdate } from "../support/telegram";

describe("scheduled tick", () => {
  it("recovers accepted updates that were never processed, and delivers replies", async () => {
    const clock = new FakeClock();
    const ids = new SequentialIds();
    const telegram = new FakeTelegram();
    const services = testServices(env.DB, { clock, ids, telegram });
    await acceptUpdate(env.DB, textUpdate(OWNER, "/help"), clock.now(), ids);
    await acceptUpdate(env.DB, textUpdate(OTHER_USER, "/start"), clock.now(), ids);

    const summary = await runTick(tickDeps(services));

    expect(summary).toMatchObject({ processedUpdates: 2, attemptedDeliveries: 2 });
    expect(
      telegram.calls.map((c) => ("chat_id" in c.params ? c.params.chat_id : null)).sort(),
    ).toEqual([OWNER, OTHER_USER]);
  });

  it("bounds deliveries per tick", async () => {
    const clock = new FakeClock();
    const ids = new SequentialIds();
    const services = testServices(env.DB, { clock, ids });
    for (let i = 0; i < TICK_LIMITS.inboxUpdatesPerUser; i++) {
      await acceptUpdate(env.DB, textUpdate(OWNER, "/help"), clock.now(), ids);
      await acceptUpdate(env.DB, textUpdate(OTHER_USER, "/help"), clock.now(), ids);
    }
    const summary = await runTick(tickDeps(services));
    expect(summary.attemptedDeliveries).toBeLessThanOrEqual(TICK_LIMITS.deliveries);
  });

  it("purges finished records only after the retention period", async () => {
    const clock = new FakeClock();
    const ids = new SequentialIds();
    const services = testServices(env.DB, { clock, ids });
    await acceptUpdate(env.DB, textUpdate(OWNER, "/help"), clock.now(), ids);
    await runTick(tickDeps(services));
    expect(await count(env.DB, "telegram_inbox")).toBe(1);

    clock.advance(FINISHED_RETENTION_MS + 1);
    await runTick(tickDeps(services));
    expect(await count(env.DB, "telegram_inbox")).toBe(0);
    expect(await count(env.DB, "telegram_outbox")).toBe(0);
  });
});
