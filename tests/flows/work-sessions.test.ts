import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { SYNC_INTERVAL_MS } from "../../src/jobs/calendar-sync";
import { rows } from "../support/db";
import { OTHER_USER } from "../support/fakes";
import { ownerCalendar, PRIMARY, setUpOwner, World } from "../support/world";

// World time starts at Fri 25 Sep 2026, 09:00 in Singapore.

function liveSessions(world: World) {
  return [...ownerCalendar(world).events.values()].filter(
    (e) => e.status !== "cancelled" && e.fields.summary === "Write report",
  );
}

async function openTask(world: World) {
  await world.send("/tasks");
  await world.press(/Write report/);
}

async function schedule(world: World) {
  await openTask(world);
  await world.press("Schedule time");
  expect(world.lastText()).toContain("Which day do you want to work on Write report?");
  await world.press("Tomorrow · Sat 26 Sep");
  expect(() => world.findButton("All day")).toThrow();
  await world.send("2-4pm");
}

describe("scheduling work time for a task (D4)", () => {
  it("creates a linked event in the default calendar and leaves the deadline alone", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await world.send("Write report by Mon");
    await schedule(world);
    expect(world.lastText()).toBe(
      "Event added: Write report\nSat 26 Sep 2026, 2–4pm · owner@example.com\n\nWork time for the task Write report. Its deadline is unchanged.",
    );
    expect(liveSessions(world).map((e) => e.calendarId)).toEqual([PRIMARY.calendarId]);
    const [task] = await rows<{ due_date: string }>(
      env.DB,
      "SELECT due_date FROM tasks WHERE title = 'Write report'",
    );
    expect(task?.due_date).toBe("2026-09-28");
    await openTask(world);
    expect(world.lastText()).toContain("Work time: Sat 26 Sep, 2pm");
  });

  it("keeps the event when the task is completed", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await world.send("Write report by Mon");
    await schedule(world);
    await world.send("/tasks");
    await world.press(/Write report/);
    await world.press("Done");
    await world.tick();
    expect(liveSessions(world)).toHaveLength(1);
  });

  it("stops listing a session deleted in Google Calendar", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await world.send("Write report by Mon");
    await schedule(world);
    const [session] = liveSessions(world);
    if (!session) throw new Error("expected the session");
    ownerCalendar(world).externalDelete(PRIMARY.calendarId, session.id);
    world.clock.advance(SYNC_INTERVAL_MS);
    await world.tick();
    await openTask(world);
    expect(world.lastText()).not.toContain("Work time");
  });

  it("refuses another user's Schedule time button", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await world.send("Write report by Mon");
    await openTask(world);
    await world.press("Schedule time", OTHER_USER);
    expect(world.answers().at(-1)).toBe("This button is no longer valid.");
  });
});
