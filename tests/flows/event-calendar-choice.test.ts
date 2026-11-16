import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { ownerCalendar, PRIMARY, setUpOwner, World } from "../support/world";

// World time starts at Fri 25 Sep 2026, 09:00 in Singapore.
const WORK = {
  calendarId: "work@group.test",
  summary: "Work",
  accessRole: "writer" as const,
  primary: false,
};
const TEAM = {
  calendarId: "team@group.test",
  summary: "Team",
  accessRole: "reader" as const,
  primary: false,
};

function liveIn(world: World, calendarId: string, title: string) {
  return [...ownerCalendar(world).events.values()].filter(
    (e) => e.calendarId === calendarId && e.status !== "cancelled" && e.fields.summary === title,
  );
}

async function startEvent(world: World, title: string) {
  await world.send("/event");
  await world.press("New event");
  await world.send(title);
}

describe("/event: choosing the calendar", () => {
  it("asks which calendar when there is more than one, default first, without view-only ones", async () => {
    const world = new World(env.DB);
    await setUpOwner(world, [PRIMARY, WORK, TEAM], ["Work", "Team (view only)"]);
    await startEvent(world, "Dinner");

    expect(world.lastText()).toBe("Which calendar is Dinner in? ✓ marks your default.");
    expect(world.findButton(`✓ ${PRIMARY.summary}`)).toBeTruthy();
    expect(world.findButton("Work")).toBeTruthy();
    expect(() => world.findButton("Team")).toThrow();
  });

  it("creates the event in the chosen calendar, not the default", async () => {
    const world = new World(env.DB);
    await setUpOwner(world, [PRIMARY, WORK], ["Work"]);
    await startEvent(world, "Standup");
    await world.press("Work");
    await world.press("Mon 28 Sep");
    await world.send("10am");
    await world.press("30 min");
    await world.noRepeat();

    expect(world.lastText()).toContain("Event added: Standup");
    expect(liveIn(world, WORK.calendarId, "Standup")).toHaveLength(1);
    expect(liveIn(world, PRIMARY.calendarId, "Standup")).toHaveLength(0);
  });

  it("keeps the chosen calendar for all-day events and repeating ones", async () => {
    const world = new World(env.DB);
    await setUpOwner(world, [PRIMARY, WORK], ["Work"]);

    await startEvent(world, "Offsite");
    await world.press("Work");
    await world.press("Mon 28 Sep");
    await world.press("All day");
    await world.noRepeat();
    expect(liveIn(world, WORK.calendarId, "Offsite")).toHaveLength(1);

    await startEvent(world, "Review");
    await world.press("Work");
    await world.press("Mon 28 Sep");
    await world.send("4pm");
    await world.press("1 hour");
    await world.press("Weekly");
    expect(liveIn(world, WORK.calendarId, "Review").length).toBeGreaterThan(0);
    expect(liveIn(world, PRIMARY.calendarId, "Review")).toHaveLength(0);
  });

  it("skips the question when only one calendar can take events", async () => {
    const world = new World(env.DB);
    await setUpOwner(world, [PRIMARY, TEAM], ["Team (view only)"]);
    await startEvent(world, "Dinner");
    expect(world.lastText()).toContain("Which day is Dinner?");
  });

  it("can be cancelled at the calendar question without creating anything", async () => {
    const world = new World(env.DB);
    await setUpOwner(world, [PRIMARY, WORK], ["Work"]);
    await startEvent(world, "Dinner");
    await world.press("Cancel");
    expect(ownerCalendar(world).events.size).toBe(0);
  });
});
