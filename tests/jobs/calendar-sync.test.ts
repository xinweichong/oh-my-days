import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { CalendarDirectory, CalendarListEntry } from "../../src/calendar/port";
import {
  CONTINUE_DELAY_MS,
  FORCE_POLL_COOLDOWN_MS,
  MAX_PAGES_PER_RUN,
  refreshCalendarLists,
  requestForcePoll,
  SYNC_INTERVAL_MS,
  type SyncDeps,
  scheduleCalendarsStatements,
  syncDueCalendars,
  syncSummary,
} from "../../src/jobs/calendar-sync";
import { count, rows } from "../support/db";
import { FakeCalendar } from "../support/fake-calendar";
import { FakeClock, OTHER_USER, OWNER, SequentialIds } from "../support/fakes";
import { userIdFor } from "../support/telegram";

const CAL = "personal@group.test";

const at = (day: number, hour: number) => ({
  dateTime: `2026-10-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00+08:00`,
  timeZone: "Asia/Singapore",
});
const event = (summary: string, day = 10, hour = 19) => ({
  summary,
  start: at(day, hour),
  end: at(day, hour + 1),
});

interface Fixture extends SyncDeps {
  clock: FakeClock;
  calendars: Map<string, FakeCalendar>;
  lists: Map<string, CalendarListEntry[] | null>;
}

function fixture(): Fixture {
  const calendars = new Map<string, FakeCalendar>();
  const lists = new Map<string, CalendarListEntry[] | null>();
  return {
    db: env.DB,
    clock: new FakeClock(Date.UTC(2026, 9, 3, 1)),
    ids: new SequentialIds("s"),
    random: () => 0.5,
    calendars,
    lists,
    sourceFor: async (userId) => {
      const calendar = calendars.get(userId);
      if (!calendar) return null;
      const directory: CalendarDirectory = {
        listCalendars: async () => {
          const list = lists.get(userId);
          return list
            ? { ok: true, value: list }
            : { ok: false, error: { kind: "retryable", retryAfterMs: null } };
        },
        createCalendar: async () => ({ ok: false, error: { kind: "validation_failed" } }),
      };
      return {
        ...directory,
        listEventPage: (calendarId, cursor) => calendar.listEventPage(calendarId, cursor),
        listWindow: (calendarId, min, max) => calendar.listWindow(calendarId, min, max),
      };
    },
  };
}

/** A user who finished setup with the given calendars selected. */
async function setupUser(f: Fixture, telegramId: number, calendarIds = [CAL]): Promise<string> {
  const now = f.clock.now();
  await env.DB.prepare(
    "INSERT INTO users (id, telegram_user_id, private_chat_id, setup_step, created_at, updated_at) VALUES (?, ?, ?, 'done', ?, ?)",
  )
    .bind(`user-${telegramId}`, telegramId, telegramId, now, now)
    .run();
  const userId = await userIdFor(env.DB, telegramId);
  await env.DB.prepare(
    `INSERT INTO google_connections (user_id, google_subject, email, scopes, refresh_token_enc,
       status, connected_at, updated_at) VALUES (?, ?, 'u@example.com', '', 'x', 'active', ?, ?)`,
  )
    .bind(userId, `sub-${telegramId}`, now, now)
    .run();
  for (const id of calendarIds) {
    await env.DB.prepare(
      `INSERT INTO calendars (user_id, calendar_id, summary, access_role, selected, updated_at)
       VALUES (?, ?, ?, 'owner', 1, ?)`,
    )
      .bind(userId, id, id, now)
      .run();
  }
  f.calendars.set(userId, new FakeCalendar());
  await env.DB.batch(scheduleCalendarsStatements(env.DB, now));
  return userId;
}

async function cachedSummaries(userId: string): Promise<string[]> {
  const list = await rows<{ summary: string }>(
    env.DB,
    "SELECT summary FROM event_cache WHERE user_id = ? ORDER BY summary",
    userId,
  );
  return list.map((r) => r.summary);
}

async function syncRow(userId: string) {
  const [row] = await rows<{
    sync_token: string | null;
    page_token: string | null;
    last_success_at: number | null;
    consecutive_failures: number;
    next_sync_at: number;
  }>(
    env.DB,
    "SELECT sync_token, page_token, last_success_at, consecutive_failures, next_sync_at FROM calendar_sync WHERE user_id = ?",
    userId,
  );
  return row;
}

async function later(f: Fixture, ms = SYNC_INTERVAL_MS): Promise<void> {
  f.clock.advance(ms);
  await syncDueCalendars(f, 10);
}

describe("calendar sync", () => {
  it("caches all events on the first run, then applies incremental edits and deletions", async () => {
    const f = fixture();
    const userId = await setupUser(f, OWNER);
    const calendar = f.calendars.get(userId) as FakeCalendar;
    calendar.seed(CAL, "a", event("Dinner"));
    calendar.seed(CAL, "b", event("Gym", 11, 7));

    expect(await syncDueCalendars(f, 10)).toBe(1);
    expect(await cachedSummaries(userId)).toEqual(["Dinner", "Gym"]);
    const first = await syncRow(userId);
    expect(first?.sync_token).not.toBeNull();
    expect(first?.last_success_at).toBe(f.clock.now());

    calendar.externalEdit(CAL, "a", { summary: "Dinner with the team" });
    calendar.externalDelete(CAL, "b");
    calendar.seed(CAL, "c", event("Lunch", 12, 12));
    expect(await syncDueCalendars(f, 10)).toBe(0); // not due yet
    await later(f);
    expect(await cachedSummaries(userId)).toEqual(["Dinner with the team", "Lunch"]);
  });

  it("advances the sync token only after the last page, continuing on later runs", async () => {
    const f = fixture();
    const userId = await setupUser(f, OWNER);
    const calendar = f.calendars.get(userId) as FakeCalendar;
    calendar.pageSize = 1;
    for (let i = 0; i < MAX_PAGES_PER_RUN + 2; i++)
      calendar.seed(CAL, `e${i}`, event(`Event ${i}`));

    await syncDueCalendars(f, 10);
    expect(await cachedSummaries(userId)).toHaveLength(MAX_PAGES_PER_RUN);
    const partial = await syncRow(userId);
    expect(partial?.sync_token).toBeNull();
    expect(partial?.page_token).not.toBeNull();
    expect(partial?.last_success_at).toBeNull();

    await later(f, CONTINUE_DELAY_MS); // continues on the next tick, not after the interval
    expect(await cachedSummaries(userId)).toHaveLength(MAX_PAGES_PER_RUN + 2);
    expect((await syncRow(userId))?.sync_token).not.toBeNull();
  });

  it("rebuilds after an expired sync token, deleting nothing until the rebuild completes", async () => {
    const f = fixture();
    const userId = await setupUser(f, OWNER);
    const calendar = f.calendars.get(userId) as FakeCalendar;
    for (const name of ["A", "B", "C", "D", "E"]) calendar.seed(CAL, name, event(name));
    await syncDueCalendars(f, 10);

    // While the token is invalid, an event vanishes without a cancellation record.
    calendar.invalidateSyncTokens();
    calendar.events.delete(`${CAL}/A`);
    calendar.pageSize = 1;
    await later(f);
    expect(await cachedSummaries(userId)).toContain("A"); // rebuild incomplete
    await later(f, CONTINUE_DELAY_MS);
    expect(await cachedSummaries(userId)).toEqual(["B", "C", "D", "E"]);
  });

  it("counts failed checks with backoff and leaves the cache untouched", async () => {
    const f = fixture();
    const userId = await setupUser(f, OWNER);
    const calendar = f.calendars.get(userId) as FakeCalendar;
    calendar.seed(CAL, "a", event("Dinner"));
    await syncDueCalendars(f, 10);

    calendar.inject({
      method: "list",
      mode: "error",
      error: { kind: "retryable", retryAfterMs: null },
    });
    await later(f);
    const failed = await syncRow(userId);
    expect(failed?.consecutive_failures).toBe(1);
    expect(failed?.next_sync_at).toBeGreaterThan(f.clock.now());
    expect(await cachedSummaries(userId)).toEqual(["Dinner"]);

    await later(f, 60 * 60_000);
    expect((await syncRow(userId))?.consecutive_failures).toBe(0);
    expect(await syncSummary(env.DB, userId)).toMatchObject({ failingCalendars: 0 });
  });

  it("does not treat lost access as deletion", async () => {
    const f = fixture();
    const userId = await setupUser(f, OWNER);
    const calendar = f.calendars.get(userId) as FakeCalendar;
    calendar.seed(CAL, "a", event("Dinner"));
    await syncDueCalendars(f, 10);

    calendar.inaccessible.add(CAL);
    await later(f);
    expect(await cachedSummaries(userId)).toEqual(["Dinner"]);
    expect((await syncRow(userId))?.consecutive_failures).toBe(1);
  });

  it("skips one-off events that ended more than 30 days ago", async () => {
    const f = fixture();
    const userId = await setupUser(f, OWNER);
    const calendar = f.calendars.get(userId) as FakeCalendar;
    calendar.seed(CAL, "old", {
      summary: "Old",
      start: { dateTime: "2026-06-01T10:00:00+08:00", timeZone: "Asia/Singapore" },
      end: { dateTime: "2026-06-01T11:00:00+08:00", timeZone: "Asia/Singapore" },
    });
    calendar.seed(CAL, "new", event("New"));
    await syncDueCalendars(f, 10);
    expect(await cachedSummaries(userId)).toEqual(["New"]);
  });

  it("drops the cache of a deselected calendar but keeps one that is merely unlisted", async () => {
    const f = fixture();
    const other = "team@group.test";
    const userId = await setupUser(f, OWNER, [CAL, other]);
    const calendar = f.calendars.get(userId) as FakeCalendar;
    calendar.seed(CAL, "a", event("Mine"));
    calendar.seed(other, "b", event("Team"));
    await syncDueCalendars(f, 10);

    await env.DB.prepare("UPDATE calendars SET listed = 0 WHERE calendar_id = ?").bind(other).run();
    await env.DB.prepare("UPDATE calendars SET selected = 0 WHERE calendar_id = ?").bind(CAL).run();
    await env.DB.batch(scheduleCalendarsStatements(env.DB, f.clock.now()));
    expect(await cachedSummaries(userId)).toEqual(["Team"]);

    calendar.externalEdit(other, "b", { summary: "Team (renamed)" });
    await later(f);
    expect(await cachedSummaries(userId)).toEqual(["Team"]); // unlisted: not synced
  });

  it("keeps each user's events separate", async () => {
    const f = fixture();
    const owner = await setupUser(f, OWNER);
    const other = await setupUser(f, OTHER_USER);
    f.calendars.get(owner)?.seed(CAL, "a", event("Owner's"));
    f.calendars.get(other)?.seed(CAL, "a", event("Other's"));
    await syncDueCalendars(f, 10);
    expect(await cachedSummaries(owner)).toEqual(["Owner's"]);
    expect(await cachedSummaries(other)).toEqual(["Other's"]);

    f.calendars.get(other)?.externalDelete(CAL, "a");
    await later(f);
    expect(await cachedSummaries(owner)).toEqual(["Owner's"]);
    expect(await count(env.DB, "event_cache")).toBe(1);
  });

  it("coalesces Force poll requests with a cooldown", async () => {
    const f = fixture();
    const userId = await setupUser(f, OWNER);
    await syncDueCalendars(f, 10);

    expect(await requestForcePoll(env.DB, userId, f.clock.now())).toBe("accepted");
    expect((await syncRow(userId))?.next_sync_at).toBe(f.clock.now());
    expect(await requestForcePoll(env.DB, userId, f.clock.now() + 1000)).toBe("cooldown");
    await env.DB.prepare("UPDATE calendar_sync SET lease_expires_at = ?")
      .bind(f.clock.now() + FORCE_POLL_COOLDOWN_MS * 2)
      .run();
    expect(await requestForcePoll(env.DB, userId, f.clock.now() + FORCE_POLL_COOLDOWN_MS + 1)).toBe(
      "running",
    );
  });

  it("refreshes the calendar list hourly without dropping calendars on failure", async () => {
    const f = fixture();
    const userId = await setupUser(f, OWNER);
    f.lists.set(userId, null); // listing fails
    await refreshCalendarLists(f, 10);
    expect(await count(env.DB, "calendars", "listed = 1")).toBe(1);

    f.clock.advance(60 * 60_000);
    f.lists.set(userId, [
      { calendarId: CAL, summary: "Personal", accessRole: "owner", primary: false },
      { calendarId: "new@group.test", summary: "New", accessRole: "writer", primary: false },
    ]);
    await refreshCalendarLists(f, 10);
    const list = await rows<{ calendar_id: string; selected: number }>(
      env.DB,
      "SELECT calendar_id, selected FROM calendars ORDER BY calendar_id",
    );
    expect(list).toEqual([
      { calendar_id: "new@group.test", selected: 0 }, // new calendars are not auto-selected
      { calendar_id: CAL, selected: 1 },
    ]);
  });
});
