import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { setUpOwner, World } from "../support/world";

async function healthz(world: World): Promise<[number, string]> {
  const response = await world.request("/healthz");
  return [response.status, await response.text()];
}

describe("/healthz scheduler liveness", () => {
  it("reports the age of the last finished tick, and 503 once the cron has paused", async () => {
    const world = new World(env.DB);
    expect(await healthz(world)).toEqual([503, "stale tick_age_s=unknown"]);

    await world.tick();
    expect(await healthz(world)).toEqual([200, "ok tick_age_s=0"]);

    // The cron pauses: no ticks while time passes.
    world.clock.advance(9 * 60_000);
    expect(await healthz(world)).toEqual([200, "ok tick_age_s=540"]);
    world.clock.advance(2 * 60_000);
    expect(await healthz(world)).toEqual([503, "stale tick_age_s=660"]);

    await world.tick();
    expect(await healthz(world)).toEqual([200, "ok tick_age_s=0"]);
  });

  it("shows the same figure in /health, without other users' data", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    world.clock.advance(3 * 60_000);
    await world.send("/health");
    expect(world.lastText()).toContain("Scheduler: last run 3 min ago");
    world.clock.advance(10 * 60_000);
    await world.send("/health");
    expect(world.lastText()).toContain(
      "Scheduler: last run 13 min ago (delayed: reminders may be late)",
    );
  });
});
