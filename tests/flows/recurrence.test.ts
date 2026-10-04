import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { tickDeps } from "../../src/app";
import { OCCURRENCES_PER_RUN } from "../../src/application/series";
import { SYNC_INTERVAL_MS } from "../../src/jobs/calendar-sync";
import { runTick } from "../../src/jobs/tick";
import { rows } from "../support/db";
import { ownerCalendar, PRIMARY, setUpOwner, World } from "../support/world";

// World time starts at Fri 25 Sep 2026, 09:00 in Singapore.
const sgt = (month: number, day: number, hour: number) => Date.UTC(2026, month - 1, day, hour - 8);

async function recurringTask(
  world: World,
  title: string,
  day: string,
  freq: string,
  typed = false,
) {
  await world.send("/task");
  await world.press("New task");
  await world.send(title);
  if (typed) await world.send(day);
  else await world.press(day);
  await world.press("Any time that day");
  await world.press(freq);
}

async function occurrences(title: string) {
  return rows<{ id: string; occurrence_date: string; status: string }>(
    env.DB,
    "SELECT id, occurrence_date, status FROM tasks WHERE title = ? ORDER BY occurrence_date",
    title,
  );
}

async function until(world: World, instant: number) {
  world.clock.current = instant;
  await world.tick();
}

describe("recurring tasks", () => {
  it("keeps each occurrence independent: September stays open when October is done", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await recurringTask(world, "Pay rent", "Tomorrow · Sat 26 Sep", "Monthly");
    expect(world.lastText()).toBe(
      "Recurring task added to Inbox: Pay rent.\nEvery month on the 26th. First due Sat 26 Sep.",
    );

    await until(world, sgt(10, 1, 9));
    const list = await occurrences("Pay rent");
    expect(list.map((o) => o.occurrence_date)).toEqual(["2026-09-26", "2026-10-26", "2026-11-26"]);

    // Complete October's occurrence; September's stays open and overdue.
    await world.send("/tasks");
    await world.press(/Pay rent · Mon 26 Oct/);
    await world.press("Done");
    const after = await occurrences("Pay rent");
    expect(after.map((o) => o.status)).toEqual(["open", "completed", "open"]);
    await world.send("/overdue");
    expect(world.lastText()).toBe("1 task is overdue.");
  });

  it("groups several overdue occurrences into one agenda line", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await recurringTask(world, "Water plants", "Tomorrow · Sat 26 Sep", "Weekly");
    await until(world, sgt(10, 4, 8));
    const agenda =
      world
        .texts()
        .filter((t) => t.startsWith("Here's your day."))
        .at(-1) ?? "";
    expect(agenda).toContain("2 tasks are overdue");
    expect(agenda).toContain("• [Inbox] Water plants · 2 overdue (due Sat 26 Sep, Sat 3 Oct)");
  });

  it("states and follows month-end rules instead of clamping dates", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await recurringTask(world, "Pay invoice", "31 Oct", "Monthly", true);
    expect(world.lastText()).toContain(
      "Every month on the 31st (months without a 31st are skipped).",
    );
    await until(world, sgt(12, 1, 9));
    expect((await occurrences("Pay invoice")).map((o) => o.occurrence_date)).toEqual([
      "2026-10-31",
      "2026-12-31", // November has no 31st; 31 January is beyond the 60-day horizon
    ]);
  });

  it("backfills occurrences missed during an outage, a bounded number per run", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await recurringTask(world, "Stretch", "Tomorrow · Sat 26 Sep", "Daily");
    await world.tick();
    const before = (await occurrences("Stretch")).length;

    // The bot is down for 90 days, then resumes.
    world.clock.current = sgt(12, 24, 9);
    await runTick(tickDeps(world.services)); // a single run
    const firstRun = (await occurrences("Stretch")).length;
    expect(firstRun - before).toBeLessThanOrEqual(OCCURRENCES_PER_RUN);
    for (let i = 0; i < 6; i++) await world.tick();
    const dates = (await occurrences("Stretch")).map((o) => o.occurrence_date);
    // Every day is present once, including the days the bot was down.
    expect(new Set(dates).size).toBe(dates.length);
    expect(dates).toContain("2026-11-15");
    expect(dates.at(-1)).toBe("2027-02-22"); // 60 days after 24 Dec
  });

  it("cancels only the occurrence whose marker is deleted in Calendar", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await recurringTask(world, "Pay rent", "Tomorrow · Sat 26 Sep", "Monthly");
    await world.tick();
    world.clock.advance(SYNC_INTERVAL_MS);
    await world.tick();
    const [september] = await rows<{ projection_calendar_id: string; projection_event_id: string }>(
      env.DB,
      "SELECT projection_calendar_id, projection_event_id FROM tasks WHERE occurrence_date = '2026-09-26'",
    );
    if (!september) throw new Error("no marker");
    ownerCalendar(world).externalDelete(
      september.projection_calendar_id,
      september.projection_event_id,
    );
    world.clock.advance(SYNC_INTERVAL_MS);
    await world.tick();
    // 26 Nov is beyond the 60-day horizon from 25 Sep, so two occurrences exist.
    expect((await occurrences("Pay rent")).map((o) => o.status)).toEqual(["cancelled", "open"]);
  });

  it("renames and stops the whole series only after confirmation", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await recurringTask(world, "Pay rent", "Tomorrow · Sat 26 Sep", "Monthly");
    await until(world, sgt(10, 1, 9));

    await world.send("/tasks");
    await world.press(/Pay rent · Mon 26 Oct/);
    await world.press("Series");
    await world.press("Rename series");
    await world.send("Pay the rent");
    expect(world.lastText()).toBe("Rename every open occurrence of Pay rent to Pay the rent?");
    expect(await occurrences("Pay the rent")).toHaveLength(0);
    await world.press("Rename series");
    expect(await occurrences("Pay the rent")).toHaveLength(3);

    await world.send("/tasks");
    await world.press(/Pay the rent · Mon 26 Oct/);
    await world.press("Series");
    await world.press("Stop series");
    expect(world.lastText()).toBe(
      "Stop repeating Pay the rent? Open occurrences from today on are cancelled. 1 earlier occurrence stays open.",
    );
    await world.press("Stop series");
    expect((await occurrences("Pay the rent")).map((o) => o.status)).toEqual([
      "open",
      "cancelled",
      "cancelled",
    ]);
    await until(world, sgt(12, 30, 9));
    expect(await occurrences("Pay the rent")).toHaveLength(3); // no new occurrences
  });
});

describe("recurring events", () => {
  it("creates a native recurring event and states its schedule", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await world.send("/event");
    await world.press("New event");
    await world.send("Standup");
    await world.press("Mon 28 Sep");
    await world.send("9am");
    await world.press("30 min");
    await world.press("Weekly");
    expect(world.lastText()).toBe(
      "Event added: Standup\nMon 28 Sep 2026, 9–9:30am · owner@example.com\nRepeats: Every week on Monday",
    );
    const created = [...ownerCalendar(world).extras.entries()].find(([, x]) => x.recurrence);
    expect(created?.[1].recurrence).toEqual(["RRULE:FREQ=WEEKLY"]);
  });

  function seedSeries(world: World) {
    const calendar = ownerCalendar(world);
    const at = (d: number, h: number) => ({
      dateTime: `2026-09-${d}T${String(h).padStart(2, "0")}:00:00+08:00`,
      timeZone: "Asia/Singapore",
    });
    calendar.seed(
      PRIMARY.calendarId,
      "standup",
      { summary: "Standup", start: at(28, 9), end: at(28, 10) },
      { recurring: true },
    );
    calendar.seed(
      PRIMARY.calendarId,
      "standup_20260928",
      { summary: "Standup", start: at(28, 9), end: at(28, 10) },
      { recurringEventId: "standup" },
    );
    calendar.seed(
      PRIMARY.calendarId,
      "standup_20260929",
      { summary: "Standup", start: at(29, 9), end: at(29, 10) },
      { recurringEventId: "standup" },
    );
  }

  it("changes one occurrence without touching the series", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    seedSeries(world);
    await world.send("/event");
    await world.press("Change an event");
    await world.press(/Mon 28 Sep, 9am · Standup/);
    expect(world.lastText()).toContain("Part of a recurring series");
    await world.press("Rename this");
    await world.send("Standup (moved room)");
    const calendar = ownerCalendar(world);
    expect(calendar.live(PRIMARY.calendarId, "standup_20260928")?.fields.summary).toBe(
      "Standup (moved room)",
    );
    expect(calendar.live(PRIMARY.calendarId, "standup")?.fields.summary).toBe("Standup");
    expect(calendar.live(PRIMARY.calendarId, "standup_20260929")?.fields.summary).toBe("Standup");
  });

  it("confirms before renaming, moving, or deleting the whole series", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    seedSeries(world);
    const calendar = ownerCalendar(world);
    const open = async () => {
      await world.send("/event");
      await world.press("Change an event");
      await world.press(/Tue 29 Sep, 9am · Standup/);
    };

    await open();
    await world.press("Rename series");
    await world.send("Team standup");
    expect(world.lastText()).toBe("Rename every occurrence of Standup to Team standup?");
    expect(calendar.live(PRIMARY.calendarId, "standup")?.fields.summary).toBe("Standup");
    await world.press("Change series");
    expect(calendar.live(PRIMARY.calendarId, "standup")?.fields.summary).toBe("Team standup");
    expect(world.lastText()).toContain("Series updated: Team standup");

    await open();
    await world.press("Series time");
    await world.send("10am");
    expect(world.lastText()).toBe(
      "Move every occurrence of Team standup to 10–11am?\nEach occurrence keeps its date.",
    );
    await world.press("Change series");
    expect(calendar.live(PRIMARY.calendarId, "standup")?.fields.start).toEqual({
      dateTime: "2026-09-28T10:00:00+08:00",
      timeZone: "Asia/Singapore",
    });

    await open();
    await world.press("Delete series");
    expect(world.lastText()).toContain("Delete every occurrence of Team standup?");
    await world.press("Delete series");
    expect(calendar.live(PRIMARY.calendarId, "standup")).toBeNull();
    expect(world.lastText()).toBe("Deleted every occurrence of Team standup.");
  });
});
