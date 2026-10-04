import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { SYNC_INTERVAL_MS } from "../../src/jobs/calendar-sync";
import { ownerCalendar, PRIMARY, setUpOwner, World } from "../support/world";

// The world clock starts at Fri 25 Sep 2026, 09:00 in Singapore.
const sg = (local: string) => ({ dateTime: `${local}+08:00`, timeZone: "Asia/Singapore" });
const TEAM = {
  calendarId: "team@group.test",
  summary: "Team",
  accessRole: "reader" as const,
  primary: false,
};

async function newEvent(world: World, title: string, day: string, time: string, length: string) {
  await world.send("/event");
  await world.press("New event");
  await world.send(title);
  await world.press(day);
  await world.send(time);
  if (/^\d+ (min|hour|hours)$/.test(length)) await world.press(length);
  else await world.send(length);
  await world.noRepeat();
}

describe("/event: creating events", () => {
  it("guides title, day, time, and length, then reports the exact result with Undo", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await newEvent(world, "Dinner", "Tomorrow · Sat 26 Sep", "7pm", "1 hour");

    expect(world.lastText()).toBe(
      "Event added: Dinner\nSat 26 Sep 2026, 7–8pm · owner@example.com",
    );
    expect(world.findButton("Undo")).toBeTruthy();
    const created = [...ownerCalendar(world).events.values()].find(
      (e) => e.fields.summary === "Dinner",
    );
    expect(created?.fields.start).toEqual(sg("2026-09-26T19:00:00"));
    expect(created?.fields.end).toEqual(sg("2026-09-26T20:00:00"));
  });

  it("accepts a typed date and an end time, rolling past midnight", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await world.send("/event");
    await world.press("New event");
    await world.send("Night shift");
    await world.send("9 Oct");
    await world.send("22:00");
    await world.send("until 2am");
    await world.noRepeat();
    expect(world.lastText()).toBe(
      "Event added: Night shift\nFri 9 Oct 2026, 10pm – Sat 10 Oct, 2am · owner@example.com",
    );
  });

  it("creates all-day events on the chosen date", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await world.send("/event");
    await world.press("New event");
    await world.send("Holiday");
    await world.press("Mon 28 Sep");
    await world.press("All day");
    await world.noRepeat();
    expect(world.lastText()).toBe(
      "Event added: Holiday\nMon 28 Sep 2026 (all day) · owner@example.com",
    );
  });

  it("asks again for input it doesn't recognize, without guessing", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await world.send("/event");
    await world.press("New event");
    await world.send("Dinner");
    await world.send("next friday");
    expect(world.lastText()).toContain("I didn't recognize that date");
    await world.send("26 Sep");
    await world.send("seven");
    expect(world.lastText()).toContain("I didn't recognize that time");
    await world.send("19:00");
    await world.send("ages");
    expect(world.lastText()).toContain("I didn't recognize that");
    expect(ownerCalendar(world).events.size).toBe(0);
  });

  it("flags overlapping events but ignores free time, declined invitations, and task markers", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    const calendar = ownerCalendar(world);
    const at = (h: number, m = 0) =>
      sg(`2026-09-26T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`);
    calendar.seed(PRIMARY.calendarId, "busy", {
      summary: "Team sync",
      start: at(19, 30),
      end: at(20, 30),
    });
    calendar.seed(
      PRIMARY.calendarId,
      "free",
      { summary: "Focus", start: at(19), end: at(20) },
      { transparent: true },
    );
    calendar.seed(
      PRIMARY.calendarId,
      "no",
      { summary: "Declined", start: at(19), end: at(20) },
      { declined: true },
    );

    await newEvent(world, "Dinner", "Tomorrow · Sat 26 Sep", "7pm", "1 hour");
    expect(world.lastText()).toBe(
      [
        "Event added: Dinner",
        "Sat 26 Sep 2026, 7–8pm · owner@example.com",
        "",
        "Overlaps with:",
        "• Team sync, Sat 26 Sep 2026, 7:30–8:30pm",
      ].join("\n"),
    );
  });
});

describe("/event: changing events", () => {
  async function withDinner(world: World, meta = {}, calendarId = PRIMARY.calendarId) {
    ownerCalendar(world).seed(
      calendarId,
      "dinner",
      { summary: "Dinner", start: sg("2026-09-26T19:00:00"), end: sg("2026-09-26T20:30:00") },
      meta,
    );
    world.clock.advance(SYNC_INTERVAL_MS);
    await world.tick();
    await world.send("/event");
    await world.press("Change an event");
    await world.press(/Dinner$/);
  }

  it("lists synced events, including ones created outside the bot", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await withDinner(world);
    expect(world.lastText()).toBe("Dinner\nSat 26 Sep 2026, 7–8:30pm · owner@example.com");
  });

  it("renames, moves keeping the length, and deletes after confirmation", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await withDinner(world);

    await world.press("Rename");
    await world.send("Dinner with Sam");
    expect(world.lastText()).toBe(
      "Event updated: Dinner with Sam\nSat 26 Sep 2026, 7–8:30pm · owner@example.com",
    );

    await world.send("/event");
    await world.press("Change an event");
    await world.press(/Dinner with Sam$/);
    await world.press("Change time");
    await world.press("Mon 28 Sep");
    await world.send("6pm");
    expect(world.lastText()).toBe(
      "Event updated: Dinner with Sam\nMon 28 Sep 2026, 6–7:30pm · owner@example.com",
    );

    await world.send("/event");
    await world.press("Change an event");
    await world.press(/Dinner with Sam$/);
    await world.press("Delete");
    expect(world.lastText()).toContain("Delete event: Dinner with Sam");
    expect(ownerCalendar(world).live(PRIMARY.calendarId, "dinner")).not.toBeNull();
    await world.press("Delete");
    expect(ownerCalendar(world).live(PRIMARY.calendarId, "dinner")).toBeNull();
    expect(world.lastText()).toBe("Event deleted: Dinner with Sam\nMon 28 Sep 2026, 6–7:30pm");
  });

  it("shows edits made in Google Calendar after the next sync", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await withDinner(world);
    ownerCalendar(world).externalEdit(PRIMARY.calendarId, "dinner", { summary: "Dinner (moved)" });
    world.clock.advance(SYNC_INTERVAL_MS);
    await world.tick();
    await world.send("/event");
    await world.press("Change an event");
    expect(() => world.findButton(/Dinner \(moved\)$/)).not.toThrow();
  });

  it("does not offer changes to events someone else organizes", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await withDinner(world, { attendees: ["host@example.com"], organizerSelf: false });
    expect(world.lastText()).toContain("Someone else organizes this event");
    expect(() => world.findButton("Rename")).toThrow();
  });

  it("does not offer changes on view-only calendars", async () => {
    const world = new World(env.DB);
    await setUpOwner(world, [PRIMARY, TEAM], ["Team (view only)"]);
    await withDinner(world, {}, TEAM.calendarId);
    expect(world.lastText()).toContain("This calendar is view-only");
  });
});

describe("/health", () => {
  it("shows the last sync and coalesces Force poll", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    world.clock.advance(2 * 60_000);
    await world.send("/health");
    expect(world.lastText()).toContain("Last successful sync: 2 min ago");
    await world.press("Force poll");
    expect(world.answers().at(-1)).toBe(
      "Checking Google Calendar now. Send /health in a minute to see the result.",
    );
    await world.press("Force poll");
    expect(world.answers().at(-1)).toBe(
      "Google Calendar was checked moments ago. Try again in a minute.",
    );
  });
});
