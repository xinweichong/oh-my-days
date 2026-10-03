import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { tickDeps } from "../../src/app";
import { runReminders } from "../../src/jobs/reminders";
import { rows } from "../support/db";
import { ownerCalendar, PRIMARY, setUpOwner, World } from "../support/world";

// World time starts at Fri 25 Sep 2026, 09:00 in Singapore (01:00 UTC).

const sgt = (day: number, hour: number, minute = 0) => Date.UTC(2026, 8, day, hour - 8, minute);
const at = (day: number, hour: number, minute = 0) => ({
  dateTime: `2026-09-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+08:00`,
  timeZone: "Asia/Singapore",
});

async function until(world: World, instant: number): Promise<void> {
  world.clock.current = instant;
  await world.tick();
}

function seedEvent(
  world: World,
  id: string,
  summary: string,
  day: number,
  hour: number,
  meta = {},
) {
  ownerCalendar(world).seed(
    PRIMARY.calendarId,
    id,
    { summary, start: at(day, hour), end: at(day, hour + 1) },
    meta,
  );
}

async function addTask(world: World, title: string, day: string | null, time: string | null) {
  await world.send("/task");
  await world.press("New task");
  await world.send(title);
  if (day === null) return world.press("No deadline");
  await world.press(day);
  if (time === null) await world.press("Any time that day");
  else await world.send(time);
  return world.noRepeat();
}

function agendas(world: World): string[] {
  return world.texts().filter((t) => t.startsWith("Here's your day."));
}

describe("daily agenda", () => {
  it("sends one combined agenda at 8am local time with events, due, overdue, and open-ended tasks", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    seedEvent(world, "standup", "Standup", 26, 9);
    seedEvent(world, "declined", "Declined meeting", 26, 11, { declined: true });
    ownerCalendar(world).seed(PRIMARY.calendarId, "holiday", {
      summary: "Holiday",
      start: { date: "2026-09-26" },
      end: { date: "2026-09-27" },
    });
    await addTask(world, "Submit expenses", "Tomorrow · Sat 26 Sep", "3pm");
    await addTask(world, "Pay rent", "Today · Fri 25 Sep", null);
    await addTask(world, "Buy milk", null, null);

    await until(world, sgt(26, 7, 59));
    expect(agendas(world)).toHaveLength(1); // Friday's, sent during setup
    await until(world, sgt(26, 8));
    expect(agendas(world).at(-1)).toBe(
      [
        "Here's your day.",
        "Sat 26 Sep 2026",
        "",
        "Events",
        "• All day · Holiday",
        "• 9–10am Standup",
        "",
        "Due today",
        "• [Inbox] Submit expenses · 3pm",
        "",
        "1 task is overdue",
        "• [Inbox] Pay rent · due Fri 25 Sep",
        "",
        "1 task without a deadline",
      ].join("\n"),
    );
    expect(world.findButton("View week")).toBeTruthy();

    await until(world, sgt(26, 12));
    expect(agendas(world)).toHaveLength(2); // no duplicate for the same date
  });

  it("says the calendar is clear, and folds a snooze ending at 8am into the agenda", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await addTask(world, "Pay rent", "Today · Fri 25 Sep", null);
    await world.send("/tasks");
    await world.press(/Pay rent/);
    await world.press("Snooze");
    await world.press("Tomorrow at 8am");
    expect(world.lastText()).toBe(
      "I'll remind you on Sat 26 Sep at 8am.\nDeadline unchanged: Fri 25 Sep.",
    );

    await until(world, sgt(26, 8));
    const agenda = agendas(world).at(-1) ?? "";
    expect(agenda).toContain("Your calendar is clear today.");
    // The snooze ended at 8am: the task is in the agenda, with no second message.
    expect(agenda).toContain("[Inbox] Pay rent · due Fri 25 Sep");
    expect(world.texts().some((t) => t.startsWith("Reminder: [Inbox] Pay rent"))).toBe(false);
  });

  it("leaves a still-snoozed task out of the agenda", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await addTask(world, "Pay rent", "Today · Fri 25 Sep", null);
    await world.send("/tasks");
    await world.press(/Pay rent/);
    await world.press("Snooze");
    await world.press("Choose date/time");
    await world.send("26 Sep 10am");
    await until(world, sgt(26, 8));
    expect(agendas(world).at(-1)).not.toContain("Pay rent");
    await until(world, sgt(26, 10));
    expect(world.lastText()).toBe("Reminder: [Inbox] Pay rent\nDue Fri 25 Sep");
  });

  it("does not send a second agenda for a date already covered when the timezone changes", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await until(world, sgt(26, 8)); // Saturday's agenda in Singapore (00:00 UTC)
    await world.send("/settings");
    await world.press("Timezone");
    await world.press("Change timezone");
    await world.send("Europe/London");
    await until(world, Date.UTC(2026, 8, 26, 7)); // 08:00 Saturday in London
    expect(agendas(world)).toHaveLength(2);
    await until(world, Date.UTC(2026, 8, 27, 7)); // 08:00 Sunday in London (BST)
    expect(agendas(world)).toHaveLength(3);
  });

  it("is sent once even when two scheduled runs overlap", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    world.clock.current = sgt(26, 8);
    const deps = tickDeps(world.services).reminders;
    await Promise.all([runReminders(deps, 10), runReminders(deps, 10)]);
    const queued = await rows(
      env.DB,
      "SELECT id FROM telegram_outbox WHERE logical_key = 'agenda:2026-09-26'",
    );
    expect(queued).toHaveLength(1);
  });
});

describe("reminders", () => {
  it("reminds one hour before a timed event, once", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    seedEvent(world, "dinner", "Dinner", 25, 19);
    await until(world, sgt(25, 17, 59));
    expect(world.texts()).not.toContain("In 1 hour: Dinner\nFri 25 Sep 2026, 7–8pm");
    await until(world, sgt(25, 18));
    expect(world.lastText()).toBe("In 1 hour: Dinner\nFri 25 Sep 2026, 7–8pm");
    await until(world, sgt(25, 18, 5));
    expect(world.texts().filter((t) => t.startsWith("In 1 hour: Dinner"))).toHaveLength(1);
  });

  it("skips declined invitations and honours a per-event override", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    seedEvent(world, "declined", "Declined", 25, 19, { declined: true });
    seedEvent(world, "dinner", "Dinner", 25, 20);
    await until(world, sgt(25, 9, 10));
    await world.send("/event");
    await world.press("Change an event");
    await world.press(/Dinner$/);
    await world.press("Reminder");
    await world.press("30 min before");
    expect(world.lastText()).toBe("Reminder for Dinner: 30 minutes before.");

    await until(world, sgt(25, 19));
    expect(world.texts().some((t) => t.includes("Declined"))).toBe(false);
    expect(world.texts().some((t) => t.startsWith("In 1 hour: Dinner"))).toBe(false);
    await until(world, sgt(25, 19, 30));
    expect(world.lastText()).toBe("In 30 minutes: Dinner\nFri 25 Sep 2026, 8–9pm");

    await world.send("/reminders");
    expect(world.lastText()).toContain("Custom reminders\n• Dinner: 30 minutes before");
  });

  it("revalidates before sending: a moved event is reminded at its new time", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    seedEvent(world, "dinner", "Dinner", 25, 19);
    await until(world, sgt(25, 17)); // horizon now knows Dinner at 7pm
    ownerCalendar(world).externalEdit(PRIMARY.calendarId, "dinner", {
      start: at(25, 21),
      end: at(25, 22),
    });
    await env.DB.prepare("UPDATE calendar_sync SET next_sync_at = ?").bind(sgt(26, 0)).run();
    await until(world, sgt(25, 18));
    expect(world.texts().some((t) => t.includes("7–8pm"))).toBe(false);

    await env.DB.prepare("UPDATE calendar_sync SET next_sync_at = 0").run();
    await until(world, sgt(25, 20));
    expect(world.lastText()).toBe("In 1 hour: Dinner\nFri 25 Sep 2026, 9–10pm");
  });

  it("after downtime, skips events that already started and summarizes the rest once", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    seedEvent(world, "early", "Early call", 25, 11);
    seedEvent(world, "lunch", "Lunch", 25, 12, {});
    seedEvent(world, "review", "Review", 25, 12);
    await until(world, sgt(25, 9, 30));
    // The bot is down from 9:30 until 11:15.
    await until(world, sgt(25, 11, 15));
    const summary = world.texts().filter((t) => t.startsWith("Reminders I couldn't send on time:"));
    expect(summary).toHaveLength(1);
    expect(summary[0]).not.toContain("Early call");
    expect(summary[0]).toContain("Lunch");
    expect(summary[0]).toContain("Review");
  });

  it("reminds one hour before an exact-time deadline, with Done and Snooze", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await addTask(world, "Send report", "Today · Fri 25 Sep", "3pm");
    await until(world, sgt(25, 14));
    expect(world.lastText()).toBe("Due in 1 hour: [Inbox] Send report\nDue Fri 25 Sep, 3pm");
    await world.press("Snooze");
    await world.press("In 1 hour");
    expect(world.lastText()).toBe(
      "I'll remind you on Fri 25 Sep at 3pm.\nDeadline unchanged: Fri 25 Sep, 3pm.",
    );
    await until(world, sgt(25, 15));
    expect(world.lastText()).toBe("Reminder: [Inbox] Send report\nDue Fri 25 Sep, 3pm");
    await world.press("Done");
    expect((await rows<{ status: string }>(env.DB, "SELECT status FROM tasks"))[0]?.status).toBe(
      "completed",
    );
  });

  it("sends no reminder for a completed task", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await addTask(world, "Send report", "Today · Fri 25 Sep", "3pm");
    await world.send("/tasks");
    await world.press(/Send report/);
    await world.press("Done");
    await until(world, sgt(25, 14, 30));
    expect(world.texts().some((t) => t.startsWith("Due in 1 hour"))).toBe(false);
  });

  it("uses the creation confirmation as the notice for items inside the reminder window", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await until(world, sgt(25, 9, 30));
    await world.send("/event");
    await world.press("New event");
    await world.send("Quick call");
    await world.press("Today · Fri 25 Sep");
    await world.send("10am");
    await world.press("30 min");
    await world.noRepeat();
    await addTask(world, "Reply to Sam", "Today · Fri 25 Sep", "10:15");
    await until(world, sgt(25, 9, 45));
    await until(world, sgt(25, 9, 55));
    expect(
      world.texts().some((t) => t.startsWith("In 1 hour") || t.startsWith("Due in 1 hour")),
    ).toBe(false);
  });
});

describe("views", () => {
  it("shows the current Monday–Sunday week, with navigation", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    seedEvent(world, "mon", "Planning", 21, 10);
    seedEvent(world, "sun", "Brunch", 27, 11);
    seedEvent(world, "next", "Next week", 28, 9);
    await world.send("/weekly");
    expect(world.lastText()).toBe(
      [
        "Week of Mon 21 Sep 2026",
        "",
        "Mon 21 Sep",
        "• 10–11am Planning",
        "",
        "Sun 27 Sep",
        "• 11am–12pm Brunch",
      ].join("\n"),
    );
    await world.press("Next ›");
    expect(world.telegram.calls.at(-1)?.method).toBe("editMessageText");
    expect(world.lastText()).toContain("Week of Mon 28 Sep 2026\n\nMon 28 Sep\n• 9–10am Next week");
  });

  it("shows the current month compactly and lists overdue tasks", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    seedEvent(world, "a", "Dinner", 25, 19);
    await addTask(world, "Pay rent", "Today · Fri 25 Sep", null);
    await world.send("/monthly");
    expect(world.lastText()).toBe("September 2026\nFri 25 Sep · 7pm Dinner; 1 due");

    await until(world, sgt(26, 9));
    await world.send("/overdue");
    expect(world.lastText()).toBe("1 task is overdue.");
    expect(world.findButton(/Pay rent · Fri 25 Sep/)).toBeTruthy();
  });

  it("filters a week to one calendar from /calendars", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    seedEvent(world, "a", "Dinner", 25, 19);
    await world.send("/calendars");
    await world.press(PRIMARY.summary);
    expect(world.lastText()).toContain(`Week of Mon 21 Sep 2026 · ${PRIMARY.summary}`);
    expect(world.lastText()).toContain("7–8pm Dinner");
  });

  it("lists upcoming and snoozed reminders", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    seedEvent(world, "a", "Dinner", 25, 19);
    await addTask(world, "Buy milk", null, null);
    await world.send("/tasks");
    await world.press(/Buy milk/);
    await world.press("Snooze");
    await world.press("Tomorrow at 8am");
    await until(world, sgt(25, 9, 10));
    await world.send("/reminders");
    expect(world.lastText()).toBe(
      [
        "Upcoming reminders",
        "• Fri 25 Sep 6pm — Dinner (1 hour before)",
        "",
        "Date-only deadlines are in the 8am agenda.",
        "",
        "Snoozed",
        "• [Inbox] Buy milk · until Sat 26 Sep 8am",
      ].join("\n"),
    );
  });

  it("reads Google live, and labels the synced copy when Google is unreachable", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    seedEvent(world, "a", "Dinner", 25, 19);
    await world.send("/daily");
    expect(world.lastText()).toContain("7–8pm Dinner"); // live, before any sync saw it
    ownerCalendar(world).inaccessible.add(PRIMARY.calendarId);
    await world.send("/daily");
    expect(world.lastText()).toContain(
      "Google Calendar couldn't be reached; events are from the last sync.",
    );
  });
});
