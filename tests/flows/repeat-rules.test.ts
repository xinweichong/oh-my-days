import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { rows } from "../support/db";
import { ownerCalendar, setUpOwner, World } from "../support/world";

// World time starts at Fri 25 Sep 2026, 09:00 in Singapore.

async function newTask(world: World, title: string, day: string) {
  await world.send("/task");
  await world.press("New task");
  await world.send(title);
  await world.press(day);
  await world.press("Any time that day");
}

async function occurrences(title: string): Promise<string[]> {
  const found = await rows<{ occurrence_date: string }>(
    env.DB,
    "SELECT occurrence_date FROM tasks WHERE title = ? ORDER BY occurrence_date",
    title,
  );
  return found.map((r) => r.occurrence_date);
}

function recurrenceOf(world: World, title: string) {
  const calendar = ownerCalendar(world);
  const event = [...calendar.events.entries()].find(([, e]) => e.fields.summary === title);
  return event ? { event: event[1], rule: calendar.extras.get(event[0])?.recurrence } : null;
}

describe("more repeat rules for tasks (D3)", () => {
  it("repeats on weekdays, starting on the first weekday", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await newTask(world, "Standup notes", "Tomorrow · Sat 26 Sep");
    await world.press("Weekdays");
    expect(world.lastText()).toBe(
      "Recurring task added to Inbox: Standup notes.\nEvery weekday (Monday to Friday). First due Mon 28 Sep.",
    );
    await world.tick();
    const dates = (await occurrences("Standup notes")).slice(0, 6);
    expect(dates).toEqual([
      "2026-09-28",
      "2026-09-29",
      "2026-09-30",
      "2026-10-01",
      "2026-10-02",
      "2026-10-05",
    ]);
  });

  it("repeats on the last day of each month", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await newTask(world, "Pay rent", "Today · Fri 25 Sep");
    await world.press("Last day of month");
    expect(world.lastText()).toBe(
      "Recurring task added to Inbox: Pay rent.\nEvery month on its last day. First due Wed 30 Sep.",
    );
    await world.tick();
    // Occurrences are materialized 60 days ahead (ADR 0003): through 24 Nov.
    expect(await occurrences("Pay rent")).toEqual(["2026-09-30", "2026-10-31"]);
  });

  it("repeats every N weeks from a typed interval", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await newTask(world, "Water plants", "Today · Fri 25 Sep");
    await world.press("Every…");
    expect(world.lastText()).toBe(
      "How often? Type every 2 days, every 3 weeks, or every 6 months.",
    );
    await world.send("fortnightly");
    expect(world.lastText()).toContain("I didn't recognize that.");
    await world.send("every 2 weeks");
    expect(world.lastText()).toBe(
      "Recurring task added to Inbox: Water plants.\nEvery 2 weeks on Friday. First due Fri 25 Sep.",
    );
    await world.tick();
    expect((await occurrences("Water plants")).slice(0, 3)).toEqual([
      "2026-09-25",
      "2026-10-09",
      "2026-10-23",
    ]);
  });
});

describe("more repeat rules for events (D3)", () => {
  async function newEvent(world: World, title: string, day: string) {
    await world.send("/event");
    await world.press("New event");
    await world.send(title);
    await world.press(day);
    await world.send("9am");
    await world.press("30 min");
  }

  it("creates a weekday series starting on the first weekday", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await newEvent(world, "Standup", "Sun 27 Sep");
    await world.press("Weekdays");
    expect(world.lastText()).toBe(
      "Event added: Standup\nMon 28 Sep 2026, 9–9:30am · owner@example.com\nRepeats: Every weekday (Monday to Friday)",
    );
    expect(recurrenceOf(world, "Standup")?.rule).toEqual([
      "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR",
    ]);
  });

  it("creates an every-3-days series from a typed interval", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await newEvent(world, "Run", "Tomorrow · Sat 26 Sep");
    await world.press("Every…");
    await world.send("every 3 days");
    expect(world.lastText()).toContain("Repeats: Every 3 days");
    expect(recurrenceOf(world, "Run")?.rule).toEqual(["RRULE:FREQ=DAILY;INTERVAL=3"]);
  });

  it("creates a last-day-of-month series", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await newEvent(world, "Review month", "Mon 28 Sep");
    await world.press("Last day of month");
    expect(world.lastText()).toBe(
      "Event added: Review month\nWed 30 Sep 2026, 9–9:30am · owner@example.com\nRepeats: Every month on its last day",
    );
    expect(recurrenceOf(world, "Review month")?.rule).toEqual(["RRULE:FREQ=MONTHLY;BYMONTHDAY=-1"]);
  });
});
