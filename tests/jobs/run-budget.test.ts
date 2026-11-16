import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { tickDeps } from "../../src/app";
import { SYNC_PAGE_SIZE } from "../../src/jobs/calendar-sync";
import { runTick } from "../../src/jobs/tick";
import { FREE_INVOCATION_LIMITS, RunBudget } from "../../src/shared/run-budget";
import { rows } from "../support/db";
import { OWNER } from "../support/fakes";
import { acceptUpdate, textUpdate } from "../support/telegram";
import { ownerCalendar, PRIMARY, setUpOwner, World } from "../support/world";

// Per-run budget (ADR 0009). World time starts at Fri 25 Sep 2026, 09:00 in
// Singapore (01:00 UTC). Synthetic data only.

const sgt = (day: number, hour: number, minute = 0) => Date.UTC(2026, 8, day, hour - 8, minute);
const at = (day: number, hour: number) => ({
  dateTime: `2026-09-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00+08:00`,
  timeZone: "Asia/Singapore",
});

/** One scheduled run with a fresh budget, as the Worker runs it; returns what it used. */
async function budgetedTick(world: World, budget = new RunBudget()) {
  const services = { ...world.services, db: budget.wrapDb(world.services.db), budget };
  await runTick(tickDeps(services));
  return budget.used();
}

async function ticksUntil(world: World, done: () => Promise<boolean>, max = 60) {
  const used: number[] = [];
  for (let i = 0; i < max && !(await done()); i++) {
    world.clock.current += 60_000;
    used.push((await budgetedTick(world)).queries);
  }
  return used;
}

describe("run budget", () => {
  it("counts each statement in a batch, and every outgoing call", async () => {
    const budget = new RunBudget();
    const db = budget.wrapDb(env.DB);
    await db.batch([db.prepare("SELECT 1"), db.prepare("SELECT 2"), db.prepare("SELECT 3")]);
    const calls = budget.wrapFetch(async () => new Response("ok"));
    await calls("https://example.test/a");
    await calls("https://example.test/b");
    expect(budget.used()).toEqual({ queries: 3, calls: 2 });
  });

  it("keeps a reserve so a run can always record that it finished", () => {
    const budget = new RunBudget({ queries: 10, calls: 10 });
    expect(budget.allows({ queries: 7 })).toBe(true);
    expect(budget.allows({ queries: 8 })).toBe(false);
    expect(budget.allows({ calls: 10 })).toBe(false);
  });
});

describe("a run under load stays within Workers Free's limits", () => {
  it("spreads a large first sync over several runs", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    for (let i = 0; i < 120; i++) {
      ownerCalendar(world).seed(PRIMARY.calendarId, `e${i}`, {
        summary: `Event ${i}`,
        start: at(26 + (i % 3), 9 + (i % 8)),
        end: at(26 + (i % 3), 10 + (i % 8)),
      });
    }
    await env.DB.prepare(
      "UPDATE calendar_sync SET next_sync_at = 0, sync_token = NULL WHERE calendar_id = ?",
    )
      .bind(PRIMARY.calendarId)
      .run();
    const cached = async () =>
      ((await rows(env.DB, "SELECT 1 FROM event_cache WHERE calendar_id = ?", PRIMARY.calendarId))
        .length >= 120) as boolean;
    const used = await ticksUntil(world, cached);
    expect(await cached()).toBe(true);
    expect(used.length).toBeGreaterThan(1); // more than one run's worth of pages
    expect(Math.max(...used)).toBeLessThanOrEqual(FREE_INVOCATION_LIMITS.queries);
    // About a page a minute next to the rest of each run's work.
    expect(used.length).toBeLessThanOrEqual(2 * Math.ceil(120 / SYNC_PAGE_SIZE) + 2);
  });

  it("sends five people's agendas in the same minute within the limit, a few minutes apart at most", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    // Four more people sharing the owner's timezone and agenda hour (synthetic).
    const owner = await env.DB.prepare("SELECT * FROM users").first<Record<string, unknown>>();
    if (!owner) throw new Error("no owner");
    const columns = Object.keys(owner);
    for (let i = 2; i <= 5; i++) {
      const values = {
        ...owner,
        id: `user-${i}`,
        telegram_user_id: 9000 + i,
        private_chat_id: 9000 + i,
      };
      await env.DB.prepare(
        `INSERT INTO users (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
      )
        .bind(...columns.map((c) => values[c as keyof typeof values]))
        .run();
    }
    await env.DB.prepare("UPDATE users SET next_due_at = NULL").run();
    world.clock.current = sgt(26, 8) - 60_000;
    const agendas = async () =>
      (await rows(env.DB, "SELECT 1 FROM agenda_runs WHERE local_date = '2026-09-26'")).length;
    const used: number[] = [];
    for (let i = 0; i < 6 && (await agendas()) < 5; i++) {
      world.clock.current += 60_000;
      used.push((await budgetedTick(world)).queries);
    }
    expect(await agendas()).toBe(5);
    expect(used.length).toBeLessThanOrEqual(5);
    expect(Math.max(...used)).toBeLessThanOrEqual(FREE_INVOCATION_LIMITS.queries);
  });

  it("creates a new daily task's occurrences over runs within the limit", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await world.send("/task");
    await world.press("New task");
    await world.send("Water plants");
    await world.press("Today · Fri 25 Sep");
    await world.press("Any time that day");
    await world.press("Daily");
    const occurrences = async () =>
      (await rows(env.DB, "SELECT 1 FROM tasks WHERE title = 'Water plants'")).length;
    const used = await ticksUntil(world, async () => (await occurrences()) >= 60, 10);
    expect(await occurrences()).toBeGreaterThanOrEqual(60);
    expect(Math.max(...used)).toBeLessThanOrEqual(FREE_INVOCATION_LIMITS.queries);
  });

  it("leaves what doesn't fit for the next run, losing nothing", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await world.send("Pay rent by tomorrow");
    const pending = async () =>
      (await rows(env.DB, "SELECT 1 FROM telegram_outbox WHERE status = 'pending'")).length;
    // Queue a backlog of messages without sending them.
    const [user] = await rows<{ id: string; private_chat_id: number }>(
      env.DB,
      "SELECT id, private_chat_id FROM users",
    );
    for (let i = 0; i < 30; i++) {
      await env.DB.prepare(
        `INSERT INTO telegram_outbox (id, user_id, logical_key, method, payload, status, attempts,
           due_at, created_at, updated_at)
         VALUES (?, ?, ?, 'sendMessage', ?, 'pending', 0, 0, 0, 0)`,
      )
        .bind(
          `backlog-${i}`,
          user?.id,
          `backlog:${i}`,
          JSON.stringify({ chat_id: user?.private_chat_id, text: `Message ${i}` }),
        )
        .run();
    }
    // A run whose budget is nearly spent sends only what fits.
    const tight = new RunBudget({ queries: 20, calls: 50 });
    world.clock.current += 60_000;
    const used = await budgetedTick(world, tight);
    expect(used.queries).toBeLessThanOrEqual(20);
    expect(await pending()).toBeGreaterThan(0);
    // Full runs then send the rest, each within the limit.
    const later = await ticksUntil(world, async () => (await pending()) === 0, 10);
    expect(await pending()).toBe(0);
    expect(Math.max(...later)).toBeLessThanOrEqual(FREE_INVOCATION_LIMITS.queries);
  });

  it("stays within the limit with everything due at once, and catches up", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    // A calendar due for a fresh sync of 50 events.
    for (let i = 0; i < 50; i++) {
      ownerCalendar(world).seed(PRIMARY.calendarId, `x${i}`, {
        summary: `Busy ${i}`,
        start: at(26, 9 + (i % 10)),
        end: at(26, 10 + (i % 10)),
      });
    }
    await env.DB.prepare("UPDATE calendar_sync SET next_sync_at = 0, sync_token = NULL").run();
    // The morning agenda, maintenance, and cleanup all due.
    world.clock.current = sgt(26, 8);
    await env.DB.prepare("UPDATE users SET next_due_at = NULL").run();
    await env.DB.prepare("DELETE FROM app_state WHERE key LIKE 'maintenance:%'").run();
    // Messages that arrived but weren't handled yet, one creating an event.
    for (const [i, text] of ["Dinner Sat 7pm", "Buy milk", "/daily", "Pay rent by Mon"].entries()) {
      await acceptUpdate(
        env.DB,
        textUpdate(OWNER, text, { updateId: 500 + i }),
        world.clock.now(),
        world.services.ids,
      );
    }
    const settled = async () =>
      (await rows(env.DB, "SELECT 1 FROM telegram_inbox WHERE status IN ('pending', 'processing')"))
        .length === 0 &&
      (await rows(env.DB, "SELECT 1 FROM telegram_outbox WHERE status IN ('pending', 'sending')"))
        .length === 0 &&
      (await rows(env.DB, "SELECT 1 FROM calendar_sync WHERE sync_token IS NULL")).length === 0;
    const used: number[] = [];
    for (let i = 0; i < 20 && !(await settled()); i++) {
      used.push((await budgetedTick(world)).queries);
      world.clock.current += 60_000;
    }
    expect(await settled()).toBe(true);
    expect(Math.max(...used)).toBeLessThanOrEqual(FREE_INVOCATION_LIMITS.queries);
    expect(world.texts().some((t) => t.startsWith("Here's your day."))).toBe(true);
  });
});
