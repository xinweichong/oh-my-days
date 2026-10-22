import { viewCalendars } from "../application/calendar-view";
import type { CalendarSyncSource } from "../calendar/port";
import type { Clock } from "../shared/clock";
import { logEvent } from "../shared/log";
import { fits, type RunBudget, UNIT_COSTS } from "../shared/run-budget";
import { listStoredCalendars } from "../storage/google";
import { type HorizonEvent, replaceHorizonStatements } from "../storage/reminders";
import { findUserById } from "../storage/users";

/** How often each user's upcoming-events horizon is rebuilt (sync changes also trigger it). */
export const HORIZON_REFRESH_MS = 10 * 60_000;
/** Covers the longest built-in reminder (1 day) plus the agenda's day. */
export const HORIZON_AHEAD_MS = 26 * 60 * 60_000;

const NO_DISPLAY = { location: null, callUrl: null, htmlLink: null };

export interface HorizonDeps {
  db: D1Database;
  clock: Clock;
  sourceFor: (userId: string) => Promise<CalendarSyncSource | null>;
  /** The invocation's budget (ADR 0009); absent where the work has its own bounds. */
  budget?: RunBudget | undefined;
}

/**
 * Rebuilds the horizon of upcoming timed event occurrences (recurring instances
 * included) for users whose copy is stale. A calendar that cannot be read keeps
 * the previous rows; nothing is removed on a partial read.
 */
export async function refreshHorizons(deps: HorizonDeps, limit: number): Promise<number> {
  const now = deps.clock.now();
  const { results } = await deps.db
    .prepare(
      `SELECT u.id FROM users u JOIN google_connections g ON g.user_id = u.id
       WHERE u.setup_step = 'done' AND g.status = 'active'
         AND (u.horizon_refreshed_at IS NULL OR u.horizon_refreshed_at <= ?)
       ORDER BY u.horizon_refreshed_at LIMIT ?`,
    )
    .bind(now - HORIZON_REFRESH_MS, limit)
    .all<{ id: string }>();

  for (const { id } of results) {
    if (!fits(deps.budget, UNIT_COSTS.horizon)) break;
    const user = await findUserById(deps.db, id);
    const source = await deps.sourceFor(id);
    if (!user || !source) continue;
    const calendars = viewCalendars(user, await listStoredCalendars(deps.db, id));
    const events: HorizonEvent[] = [];
    let complete = true;
    for (const calendar of calendars) {
      const listed = await source.listWindow(calendar.calendarId, now, now + HORIZON_AHEAD_MS);
      if (!listed.ok) {
        complete = false;
        break;
      }
      for (const item of listed.value) {
        const fields = item.fields;
        if (item.status === "cancelled" || !fields) continue;
        if (!("dateTime" in fields.start) || !("dateTime" in fields.end)) continue;
        events.push({
          calendarId: calendar.calendarId,
          eventId: item.id,
          summary: fields.summary,
          startsAt: Date.parse(fields.start.dateTime),
          endsAt: Date.parse(fields.end.dateTime),
          declined: item.declined,
          display: item.display ?? NO_DISPLAY,
        });
      }
    }
    if (!complete) {
      logEvent("horizon.incomplete", { userId: id });
      await deps.db
        .prepare("UPDATE users SET horizon_refreshed_at = ? WHERE id = ?")
        .bind(now, id)
        .run();
      continue;
    }
    // One statement per event plus two: keep the earliest that fit this run (ADR
    // 0009); later ones enter as the window moves on.
    const room = deps.budget ? deps.budget.queriesLeft() - 2 : events.length;
    if (room < 1) break;
    const kept =
      events.length > room
        ? [...events].sort((a, b) => a.startsAt - b.startsAt).slice(0, room)
        : events;
    if (kept.length < events.length) {
      logEvent("horizon.trimmed", { userId: id, kept: kept.length, total: events.length });
    }
    await deps.db.batch(replaceHorizonStatements(deps.db, id, kept, now));
  }
  return results.length;
}
