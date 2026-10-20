import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { tickDeps } from "../../src/app";
import { MAX_IDLE_MS, runReminders } from "../../src/jobs/reminders";
import { setNextDueStatement } from "../../src/storage/users";
import { countingDb } from "../support/counting-db";
import { rows } from "../support/db";
import { ownerCalendar, PRIMARY, setUpOwner, World } from "../support/world";

// World time starts at Fri 25 Sep 2026, 09:00 in Singapore; setup finishes then.
const sgt = (day: number, hour: number, minute = 0) => Date.UTC(2026, 8, day, hour - 8, minute);
const at = (day: number, hour: number, minute = 0) => ({
  dateTime: `2026-09-${day}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+08:00`,
  timeZone: "Asia/Singapore",
});

async function nextDue(): Promise<number | null> {
  const [user] = await rows<{ next_due_at: number | null }>(
    env.DB,
    "SELECT next_due_at FROM users WHERE setup_step = 'done'",
  );
  return user?.next_due_at ?? null;
}

/** Ticks once a minute, as the cron does. */
async function minutes(world: World, count: number) {
  for (let i = 0; i < count; i++) {
    world.clock.advance(60_000);
    await world.tick();
  }
}

describe("skipping idle users (B4)", () => {
  it("visits an idle user at most hourly, and not between", async () => {
    const counted = countingDb(env.DB);
    const world = new World(counted.db);
    await setUpOwner(world);
    await minutes(world, 1);
    const next = (await nextDue()) ?? 0;
    expect(next).toBeGreaterThan(world.clock.now());
    expect(next).toBeLessThanOrEqual(world.clock.now() + MAX_IDLE_MS);

    counted.queries.length = 0;
    await minutes(world, 59);
    const horizonReads = counted.queries.filter((q) =>
      q.startsWith("SELECT calendar_id, event_id, summary, starts_at"),
    );
    expect(horizonReads.length).toBeLessThanOrEqual(1);
  });

  it("schedules the next visit for the agenda", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    world.clock.current = sgt(26, 7, 30);
    await world.tick();
    expect(await nextDue()).toBe(sgt(26, 8));
    world.clock.current = sgt(26, 8);
    await world.tick();
    expect(world.texts().some((t) => t.startsWith("Here's your day.\nSat 26 Sep"))).toBe(true);
  });

  it("brings an earlier reminder forward when a task is added", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await minutes(world, 1); // next visit about 10:01
    await world.send("Send report by 10:15am"); // reminder due 9:15
    await minutes(world, 13);
    expect(world.texts().some((t) => t.startsWith("Due in 1 hour: [Inbox] Send report"))).toBe(
      false,
    );
    await minutes(world, 1);
    expect(world.lastText()).toBe("Due in 1 hour: [Inbox] Send report\nDue Fri 25 Sep, 10:15am");
  });

  it("brings a snooze end forward", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await world.send("Pay rent by today");
    await minutes(world, 1);
    await world.send("/tasks");
    await world.press(/Pay rent/);
    await world.press("Snooze");
    await world.press("Choose date/time");
    await world.send("9:20am");
    await minutes(world, 20);
    expect(world.lastText()).toBe("Reminder: [Inbox] Pay rent\nDue Fri 25 Sep");
  });

  it("brings a changed reminder override forward", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    ownerCalendar(world).seed(PRIMARY.calendarId, "lunch", {
      summary: "Lunch",
      start: at(26, 9, 30),
      end: at(26, 10, 30),
    });
    world.clock.current = sgt(25, 9, 10);
    await world.tick(); // horizon knows Lunch; its default reminder is tomorrow
    await world.send("/event");
    await world.press("Change an event");
    await world.press(/Lunch$/);
    await world.press("Reminders");
    await world.press("1 day"); // added to the default; due today at 9:30
    await minutes(world, 20);
    expect(world.lastText()).toBe("In 1 day: Lunch\nSat 26 Sep 2026, 9:30–10:30am");
  });

  it("brings a new calendar event's reminder forward after the horizon refresh", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await minutes(world, 1);
    ownerCalendar(world).seed(PRIMARY.calendarId, "call", {
      summary: "Call",
      start: at(25, 10, 15),
      end: at(25, 10, 45),
    });
    // The horizon refreshes within 10 minutes and the 9:15 reminder goes out on time,
    // not at the hourly visit.
    await minutes(world, 15);
    expect(world.lastText()).toBe("In 1 hour: Call\nFri 25 Sep 2026, 10:15–10:45am");
  });

  it("recomputes after a timezone change", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await world.send("/settings");
    await world.press("Timezone");
    await world.press("Change timezone");
    await world.send("Europe/London");
    expect(await nextDue()).toBeNull();
    await world.tick();
    expect(await nextDue()).not.toBeNull();
    // 8am Saturday in Singapore is midnight in London: no agenda yet.
    world.clock.current = Date.UTC(2026, 8, 26, 0);
    await world.tick();
    expect(world.texts().some((t) => t.startsWith("Here's your day."))).toBe(false);
    world.clock.current = Date.UTC(2026, 8, 26, 7); // 8am in London (BST)
    await world.tick();
    expect(world.texts().some((t) => t.startsWith("Here's your day.\nSat 26 Sep"))).toBe(true);
  });

  it("sends nothing twice when the stored time is earlier than needed", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await world.send("Send report by 9:30am"); // inside the hour: confirmed on create
    await minutes(world, 1);
    const before = world.texts().length;
    await env.DB.prepare("UPDATE users SET next_due_at = 0").run();
    await minutes(world, 3);
    expect(world.texts().length).toBe(before);
  });

  it("keeps an invalidation made while a pass was computing", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    const [user] = await rows<{ id: string; due_version: number }>(
      env.DB,
      "SELECT id, due_version FROM users",
    );
    if (!user) throw new Error("no user");
    // A change lands after the pass read the version …
    await env.DB.prepare("UPDATE users SET timezone = 'Europe/London' WHERE id = ?")
      .bind(user.id)
      .run();
    // … so the pass's stale result is not stored.
    const stored = await setNextDueStatement(env.DB, user.id, sgt(26, 8), user.due_version).run();
    expect(stored.meta.changes).toBe(0);
    expect(await nextDue()).toBeNull();
  });

  it("is safe when two passes overlap", async () => {
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
    expect(await nextDue()).toBe(sgt(26, 9));
  });
});
