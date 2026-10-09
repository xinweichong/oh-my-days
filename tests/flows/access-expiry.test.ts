import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { whenText } from "../../src/jobs/access-expiry";
import { count } from "../support/db";
import { testConfig } from "../support/fakes";
import { OWNER_ACCOUNT, setUpOwner, World } from "../support/world";

// Setup finishes at Fri 25 Sep 2026, 09:00 in Singapore; with 7-day Testing
// access, Google access is estimated to end Fri 2 Oct around 9am.
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const WARNING = "Google access ends tomorrow around 9am. Reconnect now to avoid a gap.";

function testingWorld(ttlDays: number | null = 7): World {
  const world = new World(env.DB);
  world.services.config = { ...testConfig, testingTokenTtlDays: ttlDays };
  return world;
}

async function runFor(world: World, ms: number) {
  // Frequent maintenance runs at most every 5 minutes; 30-minute steps keep it due.
  const end = world.clock.now() + ms;
  while (world.clock.now() < end) {
    world.clock.advance(30 * 60_000);
    await world.tick();
  }
}

function warnings(world: World): string[] {
  return world.texts().filter((t) => t.startsWith("Google access ends"));
}

describe("warning before Testing-mode Google access ends", () => {
  it("sends one warning about a day before, with Reconnect", async () => {
    const world = testingWorld();
    await setUpOwner(world);
    const start = world.clock.now();
    world.clock.current = start + 6 * DAY - 2 * HOUR;
    await world.tick();
    expect(warnings(world)).toEqual([]);
    await runFor(world, 3 * HOUR);
    expect(warnings(world)).toEqual([WARNING]);
    expect(world.findButton("Reconnect")).toBeTruthy();
    await runFor(world, 3 * HOUR);
    expect(warnings(world)).toEqual([WARNING]);
  });

  it("starts over after reconnecting, and warns once for the new connection", async () => {
    const world = testingWorld();
    await setUpOwner(world);
    const start = world.clock.now();
    world.clock.current = start + 6 * DAY + HOUR;
    await runFor(world, 10 * 60_000);
    expect(warnings(world)).toHaveLength(1);

    await world.press("Reconnect");
    const url = (await world.press("Reconnect Google Calendar")) ?? "";
    await world.authorize(url, OWNER_ACCOUNT);
    await runFor(world, 2 * HOUR);
    expect(warnings(world)).toHaveLength(1);

    // Reconnected at about day 6 + 1h, so the new warning is due from day 12 + 1h.
    world.clock.current = start + 12 * DAY + 2 * HOUR;
    await runFor(world, 10 * 60_000);
    expect(warnings(world)).toHaveLength(2);
  });

  it("sends nothing when the setting is unset (verified app)", async () => {
    const world = testingWorld(null);
    await setUpOwner(world);
    world.clock.current = world.clock.now() + 6 * DAY + HOUR;
    await runFor(world, 30 * 60_000);
    expect(warnings(world)).toEqual([]);
    await world.send("/health");
    expect(world.lastText()).not.toContain("Reconnect by");
  });

  it("sends nothing once access has already lapsed or needs reconnecting", async () => {
    const world = testingWorld();
    await setUpOwner(world);
    await env.DB.prepare("UPDATE google_connections SET status = 'auth_required'").run();
    world.clock.current = world.clock.now() + 6 * DAY + HOUR;
    await runFor(world, 30 * 60_000);
    expect(warnings(world)).toEqual([]);
    expect(await count(env.DB, "telegram_outbox", "logical_key LIKE 'access_expiry:%'")).toBe(0);
  });

  it("shows the estimated end in /health", async () => {
    const world = testingWorld();
    await setUpOwner(world);
    await world.send("/health");
    expect(world.lastText()).toContain("Reconnect by: Fri 2 Oct, 9am");
  });
});

describe("whenText", () => {
  const sgt = (day: number, hour: number, minute = 0) => Date.UTC(2026, 9, day, hour - 8, minute);

  it("says today, tomorrow, or the date, rounded to the local hour", () => {
    expect(whenText(sgt(2, 9, 10), sgt(1, 9), "Asia/Singapore")).toBe("tomorrow around 9am");
    expect(whenText(sgt(2, 9, 40), sgt(2, 1), "Asia/Singapore")).toBe("today around 10am");
    expect(whenText(sgt(4, 15), sgt(2, 9), "Asia/Singapore")).toBe("Sun 4 Oct around 3pm");
    // A half-hour zone rounds on its own clock: 01:10 UTC is 6:40am in Kolkata.
    expect(whenText(Date.UTC(2026, 9, 2, 1, 10), Date.UTC(2026, 9, 1, 1), "Asia/Kolkata")).toBe(
      "tomorrow around 7am",
    );
  });
});
