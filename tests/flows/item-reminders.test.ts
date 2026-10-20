import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { tickDeps } from "../../src/app";
import { MAX_DUE_PER_PASS, runReminders } from "../../src/jobs/reminders";
import { countingDb } from "../support/counting-db";
import { rows } from "../support/db";
import { appApi } from "../support/miniapp";
import { ownerCalendar, PRIMARY, setUpOwner, World } from "../support/world";

// Several reminders per item, fixed times, and date-only deadlines (ADR 0008).
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

function seedEvent(world: World, id: string, summary: string, day: number, hour: number) {
  ownerCalendar(world).seed(PRIMARY.calendarId, id, {
    summary,
    start: at(day, hour),
    end: at(day, hour + 1),
  });
}

async function openEvent(world: World, title: RegExp) {
  await world.send("/event");
  await world.press("Change an event");
  await world.press(title);
  await world.press("Reminders");
}

function count(world: World, prefix: string): number {
  return world.texts().filter((t) => t.startsWith(prefix)).length;
}

describe("several reminders on one event", () => {
  it("adds a preset to the default, and sends each reminder once", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    seedEvent(world, "dinner", "Dinner", 25, 20);
    await world.tick();
    await openEvent(world, /Dinner$/);
    await world.press("2 hours");
    expect(world.lastText()).toContain("• 2 hours before\n• 1 hour before");

    await until(world, sgt(25, 18));
    expect(world.lastText()).toBe("In 2 hours: Dinner\nFri 25 Sep 2026, 8–9pm");
    await until(world, sgt(25, 19));
    expect(world.lastText()).toBe("In 1 hour: Dinner\nFri 25 Sep 2026, 8–9pm");
    await until(world, sgt(25, 19, 30));
    expect(count(world, "In 2 hours: Dinner")).toBe(1);
    expect(count(world, "In 1 hour: Dinner")).toBe(1);
  });

  it("takes typed reminders beyond the event horizon, including a fixed time", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    seedEvent(world, "dinner", "Dinner", 26, 19); // 34 hours away: beyond the horizon
    await world.tick();
    await openEvent(world, /Dinner$/);
    await world.press("Custom…");
    await world.send("1 day before 6pm, Sat 9am");
    expect(world.lastText()).toBe(
      "Reminders for Dinner: 1 day before at 6pm; Sat 26 Sep at 9am; 1 hour before.",
    );

    await until(world, sgt(25, 18));
    expect(world.lastText()).toBe("Reminder: Dinner\nSat 26 Sep 2026, 7–8pm");
    await until(world, sgt(26, 9));
    expect(world.lastText()).toBe("Reminder: Dinner\nSat 26 Sep 2026, 7–8pm");
    await until(world, sgt(26, 18));
    expect(world.lastText()).toBe("In 1 hour: Dinner\nSat 26 Sep 2026, 7–8pm");
    expect(count(world, "Reminder: Dinner")).toBe(2);
  });

  it("follows an event moved in Calendar to its new day", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    seedEvent(world, "planning", "Planning", 28, 10);
    await world.tick();
    await openEvent(world, /Planning$/);
    await world.press("Custom…");
    await world.send("only 2 days before 9am");
    expect(world.lastText()).toBe("Reminders for Planning: 2 days before at 9am.");

    ownerCalendar(world).externalEdit(PRIMARY.calendarId, "planning", {
      start: at(29, 10),
      end: at(29, 11),
    });
    await until(world, sgt(26, 9)); // two days before the old date: re-read, moved
    expect(world.texts().some((t) => t.startsWith("Reminder: Planning"))).toBe(false);
    await until(world, sgt(27, 9)); // two days before the new date
    expect(world.lastText()).toBe("Reminder: Planning\nTue 29 Sep 2026, 10–11am");
  });

  it("sends one message when two of an item's reminders fall at the same moment", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    seedEvent(world, "dinner", "Dinner", 25, 20);
    await world.tick();
    await openEvent(world, /Dinner$/);
    await world.press("Custom…");
    await world.send("7pm"); // the same moment as the 1-hour default
    await until(world, sgt(25, 19));
    await until(world, sgt(25, 19, 5));
    expect(world.texts().filter((t) => t.includes(": Dinner\n"))).toHaveLength(1);
  });

  it("turns reminders off with None, and back on with Default", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    seedEvent(world, "dinner", "Dinner", 25, 20);
    seedEvent(world, "lunch", "Lunch", 25, 13);
    await world.tick();
    await openEvent(world, /Dinner$/);
    await world.press("None");
    expect(world.lastText()).toContain("\n\nNone.\n\n");
    await openEvent(world, /Lunch$/);
    await world.press("None");
    await world.press("Default");
    expect(world.lastText()).toContain("• 1 hour before");
    await until(world, sgt(25, 12));
    expect(count(world, "In 1 hour: Lunch")).toBe(1);
    await until(world, sgt(25, 19, 30));
    expect(world.texts().some((t) => /^(In .*|Reminder): Dinner/.test(t))).toBe(false);
  });

  it("refuses a reminder whose time has passed, and explains typed mistakes", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    seedEvent(world, "call", "Call", 25, 11);
    await world.tick();
    await openEvent(world, /Call$/);
    await world.press("1 day");
    expect(world.answers().at(-1)).toBe("1 day before: that time has passed.");
    await world.press("Custom…");
    await world.send("soonish");
    expect(world.lastText()).toBe(
      'I didn\'t recognize "soonish". Try 30m, 2h, 1 day before 6pm, 9am on the day, or Thu 9am.',
    );
    await world.send("45m, at 6");
    expect(world.lastText()).toContain('"at 6" could be morning or evening; add am or pm.');
    await world.send("45m, 1 day before");
    expect(world.lastText()).toBe(
      "Reminders for Call: 1 hour before; 45 minutes before.\nNot added: 1 day before: that time has passed.",
    );
  });

  it("leaves an unrelated question open when a reminder is toggled", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    seedEvent(world, "dinner", "Dinner", 25, 20);
    await world.tick();
    await openEvent(world, /Dinner$/);
    await world.send("/event");
    await world.press("New event");
    expect(world.lastText()).toBe("What's the event called?");
    await world.press("2 hours"); // the menu from before
    await world.send("Lunch"); // still the event's title
    const [pending] = await rows<{ kind: string }>(env.DB, "SELECT kind FROM pending_inputs");
    expect(pending?.kind).toBe("event_date");
  });

  it("keeps a reminder set before several existed", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    seedEvent(world, "dinner", "Dinner", 25, 20);
    await world.tick();
    const [user] = await rows<{ id: string }>(env.DB, "SELECT id FROM users");
    await env.DB.prepare(
      `INSERT INTO reminder_overrides (user_id, target_kind, target_key, minutes_before, updated_at)
       VALUES (?, 'event', ?, 30, ?)`,
    )
      .bind(user?.id, `${PRIMARY.calendarId}/dinner`, sgt(25, 9))
      .run();
    await until(world, sgt(25, 19, 30));
    expect(world.lastText()).toBe("In 30 minutes: Dinner\nFri 25 Sep 2026, 8–9pm");
    expect(count(world, "In 1 hour: Dinner")).toBe(0);
  });

  it("can remind before an all-day event", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    ownerCalendar(world).seed(PRIMARY.calendarId, "holiday", {
      summary: "Holiday",
      start: { date: "2026-09-27" },
      end: { date: "2026-09-28" },
    });
    await world.tick();
    await openEvent(world, /Holiday$/);
    await world.press("Day before 6pm");
    await until(world, sgt(26, 18));
    expect(world.lastText()).toMatch(/^Reminder: Holiday\nSun 27 Sep/);
  });
});

describe("task reminders", () => {
  it("sets a fixed time and a lead time by replying, and sends both", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await world.send("Send report by Mon 3pm");
    await world.send("remind me Sun 8pm and 2h");
    expect(world.lastText()).toBe(
      "Reminders for Send report: Sun 27 Sep at 8pm; 2 hours before; 1 hour before.",
    );
    await until(world, sgt(27, 20));
    expect(world.lastText()).toBe("Reminder: [Inbox] Send report\nDue Mon 28 Sep, 3pm");
    expect(world.findButton("Done")).toBeTruthy();
    await until(world, sgt(28, 13));
    expect(world.lastText()).toBe("Due in 2 hours: [Inbox] Send report\nDue Mon 28 Sep, 3pm");
  });

  it("gives date-only deadlines their own reminders, and stops after the day", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await world.send("Pay rent by Mon");
    await world.send("/tasks");
    await world.press(/Pay rent/);
    await world.press("Reminders");
    expect(world.lastText()).toBe(
      [
        "Reminders for Pay rent",
        "Mon 28 Sep",
        "",
        "None; it's in the 8am agenda on the day.",
        "",
        "Tap to add or remove (up to 5). Custom… takes your own, like 45m, 1 day before 6pm, or Thu 9am.",
      ].join("\n"),
    );
    await world.press("Day before 6pm");
    await world.press("On the day 12pm");
    await until(world, sgt(27, 18));
    expect(world.lastText()).toBe("Reminder: [Inbox] Pay rent\nDue Mon 28 Sep");
    await until(world, sgt(28, 12));
    expect(world.lastText()).toBe("Reminder: [Inbox] Pay rent\nDue Mon 28 Sep");
    await until(world, sgt(29, 12));
    expect(count(world, "Reminder: [Inbox] Pay rent")).toBe(2);

    await world.send("/reminders");
    expect(world.lastText()).not.toContain("Pay rent (");
  });

  it("asks for a time on a date-only deadline, and reads a whole day as the agenda hour", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await world.send("Pay rent by Mon");
    await world.send("remind me 2h");
    expect(world.lastText()).toBe(
      "Not added: 2h: a deadline without a time needs a day and time, like 1 day before 6pm (a whole day alone means 8am).\nTry 30m, 2h, 1 day before 6pm, 9am on the day, or Thu 9am.",
    );
    await world.send("remind me 1 day before");
    expect(world.lastText()).toBe("Reminders for Pay rent: 1 day before at 8am.");
  });

  it("still reads 'remind me to …' as a new task", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await world.send("Pay rent by Mon");
    await world.send("remind me to call Sam tomorrow");
    const titles = await rows<{ title: string }>(env.DB, "SELECT title FROM tasks ORDER BY title");
    expect(titles.map((t) => t.title)).toContain("Pay rent");
    expect(titles.length).toBe(2);
    expect(world.texts().some((t) => t.startsWith("Reminders for"))).toBe(false);
  });

  it("lists items' own reminders in /reminders", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await world.send("Send report by Mon 3pm");
    await world.send("remind me only Sun 8pm");
    await world.send("/reminders");
    expect(world.lastText()).toContain(
      "• Sun 27 Sep 8pm — [Inbox] Send report (Sun 27 Sep at 8pm)",
    );
    expect(world.lastText()).toContain("Own reminders\n• [Inbox] Send report: Sun 27 Sep at 8pm");
  });
});

describe("query budget", () => {
  it("keeps /reminders and a Mini App change within Workers Free's 50 queries", async () => {
    const counter = countingDb(env.DB);
    const world = new World(counter.db);
    await setUpOwner(world);
    await world.send("Send report by Mon 3pm");
    await world.send("remind me Sun 8pm");
    const [user] = await rows<{ id: string }>(env.DB, "SELECT id FROM users");
    // Twenty events ahead with their own reminders.
    const insert = env.DB.prepare(
      `INSERT INTO reminder_overrides (user_id, target_kind, target_key, rules, anchor_at, updated_at)
       VALUES (?, 'event', ?, '["b60","d1@09:00"]', ?, ?)`,
    );
    await env.DB.batch(
      Array.from({ length: 20 }, (_, i) =>
        insert.bind(user?.id, `${PRIMARY.calendarId}/e${i}`, sgt(28, 9 + (i % 10)), sgt(25, 9)),
      ),
    );
    const cost = async (work: () => Promise<unknown>) => {
      const before = counter.queries.length;
      await work();
      return counter.queries.length - before;
    };
    expect(await cost(() => world.send("/reminders"))).toBeLessThanOrEqual(50);
    const [task] = await rows<{ id: string }>(env.DB, "SELECT id FROM tasks");
    const [setting] = await rows<{ updated_at: number }>(
      env.DB,
      "SELECT updated_at FROM reminder_overrides WHERE target_kind = 'task'",
    );
    const write = () =>
      appApi(world, "reminders", {
        method: "POST",
        body: {
          key: "budget-key-0001",
          target: { kind: "task", taskId: task?.id },
          version: setting?.updated_at,
          action: "add",
          text: "2h",
        },
      });
    expect(await cost(write)).toBeLessThanOrEqual(50);
    // One pass for a user with twenty due at once.
    world.clock.current = sgt(27, 9);
    const pass = await cost(() => runReminders(tickDeps(world.services).reminders, 20));
    expect(pass).toBeLessThanOrEqual(50); // includes Sunday's agenda, due in the same pass
    // At most eight per pass; the rest follow on the next.
    const claimed = async () => (await rows(env.DB, "SELECT 1 FROM reminder_log")).length;
    expect(await claimed()).toBe(MAX_DUE_PER_PASS);
    await runReminders(tickDeps(world.services).reminders, 20);
    expect(await claimed()).toBe(2 * MAX_DUE_PER_PASS);
  });
});
