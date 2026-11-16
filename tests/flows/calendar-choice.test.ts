import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { OTHER_USER } from "../support/fakes";
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
const MENU = `Calendar: ${PRIMARY.summary} ▸`;

function liveIn(world: World, calendarId: string, title: string) {
  return [...ownerCalendar(world).events.values()].filter(
    (e) => e.calendarId === calendarId && e.status !== "cancelled" && e.fields.summary === title,
  );
}

async function setUp(world: World) {
  await setUpOwner(world, [PRIMARY, WORK, TEAM], ["Work", "Team (view only)"]);
}

describe("choosing the calendar of a new event (C4)", () => {
  it("moves a just-created event to another writable calendar, with Undo", async () => {
    const world = new World(env.DB);
    await setUp(world);
    await world.send("Dinner Sat 7pm");
    await world.press(MENU);
    expect(world.lastText()).toBe("Move Dinner to which calendar?");
    expect(() => world.findButton("Team")).toThrow(); // view-only
    await world.press("Work");
    expect(world.lastText()).toBe("Moved Dinner to Work.");
    expect(liveIn(world, WORK.calendarId, "Dinner")).toHaveLength(1);
    expect(liveIn(world, PRIMARY.calendarId, "Dinner")).toHaveLength(0);

    await world.press("Undo");
    expect(world.lastText()).toBe(`Undone: Dinner is back in ${PRIMARY.summary}.`);
    expect(liveIn(world, PRIMARY.calendarId, "Dinner")).toHaveLength(1);
    expect(liveIn(world, WORK.calendarId, "Dinner")).toHaveLength(0);
  });

  it("is bound to the created version: an edit since keeps it where it is", async () => {
    const world = new World(env.DB);
    await setUp(world);
    await world.send("Dinner Sat 7pm");
    const [created] = liveIn(world, PRIMARY.calendarId, "Dinner");
    if (!created) throw new Error("expected the event");
    ownerCalendar(world).externalEdit(PRIMARY.calendarId, created.id, {
      summary: "Dinner (8 people)",
    });
    await world.press(MENU);
    await world.press("Work");
    expect(world.lastText()).toBe(`Dinner changed since, so it stays in ${PRIMARY.summary}.`);
    expect(liveIn(world, WORK.calendarId, "Dinner (8 people)")).toHaveLength(0);
  });

  it("reconciles a move whose response was lost, without moving twice", async () => {
    const world = new World(env.DB);
    await setUp(world);
    await world.send("Dinner Sat 7pm");
    ownerCalendar(world).inject({ method: "move", mode: "apply_then_unknown" });
    await world.press(MENU);
    await world.press("Work");
    expect(world.lastText()).toContain("Pending: I couldn't confirm that Dinner moved to Work.");
    world.clock.advance(5 * 60_000);
    await world.tick();
    expect(world.lastText()).toBe("Moved Dinner to Work.");
    expect(ownerCalendar(world).calls.filter((c) => c === "move")).toHaveLength(1);
    expect(liveIn(world, WORK.calendarId, "Dinner")).toHaveLength(1);
  });

  it("offers no calendar button when there is nowhere else to put it", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await world.send("Dinner Sat 7pm");
    expect(world.findButton("Undo")).toBeTruthy();
    expect(() => world.findButton(MENU)).toThrow();
  });

  it("refuses another user's buttons", async () => {
    const world = new World(env.DB);
    await setUp(world);
    await world.send("Dinner Sat 7pm");
    await world.press(MENU, OTHER_USER);
    expect(world.answers().at(-1)).toBe("This button is no longer valid.");
  });
});

describe("creating a calendar from settings", () => {
  async function toNamePrompt(world: World) {
    await setUp(world);
    await world.send("/settings");
    await world.press("Default calendar");
    await world.press("Create a new calendar");
    await world.send("Projects");
  }

  it("asks whether it becomes the default, and keeps the current default on request", async () => {
    const world = new World(env.DB);
    await toNamePrompt(world);
    expect(world.lastText()).toBe("Create Projects. Should new events go there?");
    await world.press("Keep my current default");
    expect(world.texts()).toContain(
      "Created Projects. It's shown in your views; new events still go to your default calendar.",
    );
    await world.send("/settings");
    expect(world.lastText()).toContain(`Default for new events: ${PRIMARY.summary}`);
    expect(world.lastText()).toContain("Projects");
  });

  it("makes it the default when chosen", async () => {
    const world = new World(env.DB);
    await toNamePrompt(world);
    await world.press("Make it the default");
    await world.send("/settings");
    expect(world.lastText()).toContain("Default for new events: Projects");
  });

  it("refuses a name you already have", async () => {
    const world = new World(env.DB);
    await setUp(world);
    await world.send("/settings");
    await world.press("Default calendar");
    await world.press("Create a new calendar");
    await world.send("work");
    expect(world.lastText()).toBe(
      "You already have a calendar with that name. Send a different name.",
    );
  });
});
