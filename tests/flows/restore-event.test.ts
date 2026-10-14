import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { SYNC_INTERVAL_MS } from "../../src/jobs/calendar-sync";
import { OTHER_USER } from "../support/fakes";
import { ownerCalendar, PRIMARY, setUpOwner, World } from "../support/world";

// World time starts at Fri 25 Sep 2026, 09:00 in Singapore.
const at = (day: number, hour: number) => ({
  dateTime: `2026-09-${day}T${String(hour).padStart(2, "0")}:00:00+08:00`,
  timeZone: "Asia/Singapore",
});

function live(world: World, title: string) {
  return [...ownerCalendar(world).events.values()].filter(
    (e) => e.status !== "cancelled" && e.fields.summary === title,
  );
}

async function seedAndDelete(world: World, meta = {}) {
  ownerCalendar(world).seed(
    PRIMARY.calendarId,
    "dinner",
    { summary: "Dinner", start: at(26, 19), end: at(26, 20) },
    meta,
  );
  world.clock.advance(SYNC_INTERVAL_MS);
  await world.tick();
  await world.send("/event");
  await world.press("Change an event");
  await world.press(/Dinner$/);
  await world.press(/^Delete/);
  await world.press(/^Delete/);
}

describe("restoring a deleted event (C6)", () => {
  it("restores a guest-free event as a new copy in the same calendar, once", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await seedAndDelete(world);
    expect(world.lastText()).toBe("Event deleted: Dinner\nSat 26 Sep 2026, 7–8pm");
    expect(live(world, "Dinner")).toHaveLength(0);
    await world.press("Restore");
    expect(world.lastText()).toBe(
      "Event added: Dinner\nSat 26 Sep 2026, 7–8pm · owner@example.com\n\nRestored as a copy: the title and time are back; a description, location, or attachments from the original are not.",
    );
    const [copy] = live(world, "Dinner");
    expect(copy?.calendarId).toBe(PRIMARY.calendarId);
    expect(copy?.id).not.toBe("dinner");
    await world.press("Restore");
    expect(live(world, "Dinner")).toHaveLength(1);
  });

  it("offers it for 24 hours only", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await seedAndDelete(world);
    world.clock.advance(24 * 60 * 60_000 + 60_000);
    await world.press("Restore");
    expect(live(world, "Dinner")).toHaveLength(0);
  });

  it("is not offered for events with guests", async () => {
    const guests = new World(env.DB);
    await setUpOwner(guests);
    await seedAndDelete(guests, { attendees: ["guest@example.com"] }); // "Delete and notify"
    expect(guests.lastText()).toContain("Event deleted: Dinner");
    expect(() => guests.findButton("Restore")).toThrow();
  });

  it("is not offered for an occurrence of a recurring event", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await seedAndDelete(world, { recurringEventId: "weekly" });
    expect(world.lastText()).toContain("Dinner");
    expect(() => world.findButton("Restore")).toThrow();
  });

  it("refuses another user's Restore", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await seedAndDelete(world);
    await world.press("Restore", OTHER_USER);
    expect(world.answers().at(-1)).toBe("This button is no longer valid.");
    expect(live(world, "Dinner")).toHaveLength(0);
  });
});
