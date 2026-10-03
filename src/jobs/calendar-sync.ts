import type { CalendarDirectory, CalendarSyncSource, SyncedEvent } from "../calendar/port";
import type { EventFields } from "../domain/calendar-event";
import { type BackoffPolicy, retryDelayMs } from "../domain/retry";
import type { Clock } from "../shared/clock";
import type { IdGenerator } from "../shared/ids";
import { logEvent } from "../shared/log";
import {
  deleteEventStatement,
  deleteStaleGenerationStatement,
  eventEndsAt,
  upsertEventStatement,
} from "../storage/events";
import { replaceCalendarListStatements } from "../storage/google";
import type { Guard } from "../storage/guard";

/** Provisional polling interval per calendar (backend plan §5); tune after measuring. */
export const SYNC_INTERVAL_MS = 5 * 60_000;
export const SYNC_LEASE_MS = 60_000;
/** Pages per calendar per run; the rest continue on the next tick. */
export const MAX_PAGES_PER_RUN = 3;
/** Delay before continuing a page sequence, so one invocation cannot loop over it. */
export const CONTINUE_DELAY_MS = 30_000;
/** One-off events that ended longer ago than this are not cached. */
export const PAST_EVENT_RETENTION_MS = 30 * 24 * 60 * 60_000;
const FAILURE_BACKOFF: BackoffPolicy = { baseMs: 60_000, maxMs: 30 * 60_000 };

export interface SyncDeps {
  db: D1Database;
  clock: Clock;
  ids: IdGenerator;
  random: () => number;
  /** The user's Google Calendar, or null without a usable connection. */
  sourceFor: (userId: string) => Promise<(CalendarSyncSource & CalendarDirectory) | null>;
}

/** How often each user's calendar list (names, access, new calendars) is refreshed. */
export const CALENDAR_LIST_REFRESH_MS = 60 * 60_000;

/**
 * Refreshes the calendar list for users whose copy is older than the refresh
 * interval. A failed listing changes nothing and is retried an interval later.
 */
export async function refreshCalendarLists(deps: SyncDeps, limit: number): Promise<number> {
  const now = deps.clock.now();
  const { results } = await deps.db
    .prepare(
      `SELECT u.id FROM users u JOIN google_connections g ON g.user_id = u.id
       WHERE g.status = 'active' AND (u.calendars_listed_at IS NULL OR u.calendars_listed_at <= ?)
       ORDER BY u.calendars_listed_at LIMIT ?`,
    )
    .bind(now - CALENDAR_LIST_REFRESH_MS, limit)
    .all<{ id: string }>();
  for (const { id } of results) {
    const source = await deps.sourceFor(id);
    const listed = source ? await source.listCalendars() : null;
    await deps.db.batch([
      ...(listed?.ok ? replaceCalendarListStatements(deps.db, id, listed.value, now, false) : []),
      deps.db.prepare("UPDATE users SET calendars_listed_at = ? WHERE id = ?").bind(now, id),
    ]);
  }
  return results.length;
}

interface SyncRow {
  user_id: string;
  calendar_id: string;
  sync_token: string | null;
  page_token: string | null;
  generation: number;
  resync_generation: number | null;
  consecutive_failures: number;
}

/**
 * Starts tracking calendars the user selected (and the task calendar) and stops
 * tracking calendars the user deselected, dropping their cached events. A
 * calendar that merely disappeared from the list keeps its cache: losing access
 * is not evidence that events were deleted.
 */
export function scheduleCalendarsStatements(db: D1Database, now: number): D1PreparedStatement[] {
  const tracked = `SELECT c.user_id, c.calendar_id FROM calendars c JOIN users u ON u.id = c.user_id
    WHERE u.setup_step = 'done' AND (c.selected = 1 OR c.calendar_id = u.task_calendar_id)`;
  return [
    db
      .prepare(
        `INSERT INTO calendar_sync (user_id, calendar_id, next_sync_at)
         SELECT user_id, calendar_id, ? FROM (${tracked}) WHERE true
         ON CONFLICT (user_id, calendar_id) DO NOTHING`,
      )
      .bind(now),
    db.prepare(
      `DELETE FROM event_cache WHERE (user_id, calendar_id) IN (
         SELECT user_id, calendar_id FROM calendar_sync EXCEPT ${tracked})`,
    ),
    db.prepare(
      `DELETE FROM calendar_sync WHERE (user_id, calendar_id) IN (
         SELECT user_id, calendar_id FROM calendar_sync EXCEPT ${tracked})`,
    ),
  ];
}

/** Synchronizes up to `limit` due calendars, optionally for one user. */
export async function syncDueCalendars(
  deps: SyncDeps,
  limit: number,
  userId: string | null = null,
): Promise<number> {
  let synced = 0;
  while (synced < limit) {
    const lease = deps.ids.next();
    const now = deps.clock.now();
    const row = await deps.db
      .prepare(
        `UPDATE calendar_sync SET lease_token = ?1, lease_expires_at = ?2
         WHERE (user_id, calendar_id) = (
           SELECT s.user_id, s.calendar_id FROM calendar_sync s
           JOIN calendars c ON c.user_id = s.user_id AND c.calendar_id = s.calendar_id
           JOIN google_connections g ON g.user_id = s.user_id
           WHERE s.next_sync_at <= ?3 AND (s.lease_expires_at IS NULL OR s.lease_expires_at <= ?3)
             AND c.listed = 1 AND g.status = 'active' AND (?4 IS NULL OR s.user_id = ?4)
           ORDER BY s.next_sync_at LIMIT 1)
         RETURNING user_id, calendar_id, sync_token, page_token, generation, resync_generation,
           consecutive_failures`,
      )
      .bind(lease, now + SYNC_LEASE_MS, now, userId)
      .first<SyncRow>();
    if (!row) break;
    synced++;
    await syncCalendar(deps, row, lease);
  }
  return synced;
}

async function syncCalendar(deps: SyncDeps, row: SyncRow, lease: string): Promise<void> {
  const guard: Guard = {
    sql: "EXISTS (SELECT 1 FROM calendar_sync WHERE user_id = ? AND calendar_id = ? AND lease_token = ?)",
    params: [row.user_id, row.calendar_id, lease],
  };
  const key = { userId: row.user_id, calendarId: row.calendar_id };
  const finish = (sql: string, ...params: unknown[]) =>
    deps.db
      .prepare(
        `UPDATE calendar_sync SET ${sql}, lease_token = NULL, lease_expires_at = NULL
         WHERE user_id = ? AND calendar_id = ? AND lease_token = ?`,
      )
      .bind(...params, row.user_id, row.calendar_id, lease);

  const source = await deps.sourceFor(row.user_id);
  if (!source) {
    // Reauthorization is reported separately; this is not a failed check.
    await finish("next_sync_at = ?", deps.clock.now() + SYNC_INTERVAL_MS).run();
    return;
  }

  let syncToken = row.sync_token;
  let pageToken = row.page_token;
  let resync = row.resync_generation ?? (syncToken ? null : row.generation + 1);

  for (let page = 0; page < MAX_PAGES_PER_RUN; page++) {
    const result = await source.listEventPage(row.calendar_id, {
      syncToken: pageToken ? null : syncToken,
      pageToken,
    });
    const now = deps.clock.now();

    if (!result.ok && result.reset) {
      // Expired sync token: rebuild from a full listing; nothing is deleted
      // until that listing completes.
      logEvent("sync.reset", key);
      syncToken = null;
      pageToken = null;
      resync = row.generation + 1;
      continue;
    }
    if (!result.ok) {
      const failures = row.consecutive_failures + 1;
      const delay = retryDelayMs(failures, FAILURE_BACKOFF, deps.random);
      await finish(
        `consecutive_failures = ?, last_error_class = ?, next_sync_at = ?, resync_generation = ?,
         page_token = ?, sync_token = ?`,
        failures,
        result.error.kind,
        now + delay,
        resync,
        pageToken,
        syncToken,
      ).run();
      logEvent("sync.failed", { ...key, errorClass: result.error.kind, failures });
      return;
    }

    const generation = resync ?? row.generation;
    const statements = applyItems(deps.db, row, result.items, generation, now, guard);
    const last = result.nextPageToken === null;

    if (!last) {
      pageToken = result.nextPageToken;
      statements.push(
        finishPageStatement(deps.db, row, lease, {
          pageToken,
          syncToken,
          resync,
        }),
      );
      await deps.db.batch(statements);
      continue;
    }

    if (resync !== null) {
      statements.push(
        deleteStaleGenerationStatement(deps.db, row.user_id, row.calendar_id, resync, guard),
      );
    }
    statements.push(
      finish(
        `sync_token = ?, page_token = NULL, generation = ?, resync_generation = NULL,
         last_success_at = ?, consecutive_failures = 0, last_error_class = NULL, next_sync_at = ?`,
        result.nextSyncToken,
        generation,
        now,
        now + SYNC_INTERVAL_MS,
      ),
    );
    await deps.db.batch(statements);
    return;
  }

  // More pages remain: continue on a later run (bounding work per invocation)
  // without counting a result.
  await finish("next_sync_at = ?", deps.clock.now() + CONTINUE_DELAY_MS).run();
}

function finishPageStatement(
  db: D1Database,
  row: SyncRow,
  lease: string,
  state: { pageToken: string | null; syncToken: string | null; resync: number | null },
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE calendar_sync SET page_token = ?, sync_token = ?, resync_generation = ?
       WHERE user_id = ? AND calendar_id = ? AND lease_token = ?`,
    )
    .bind(state.pageToken, state.syncToken, state.resync, row.user_id, row.calendar_id, lease);
}

function applyItems(
  db: D1Database,
  row: SyncRow,
  items: readonly SyncedEvent[],
  generation: number,
  now: number,
  guard: Guard,
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  for (const item of items) {
    const stale =
      item.fields !== null &&
      !item.recurring &&
      eventEndsAt(item.fields) < now - PAST_EVENT_RETENTION_MS;
    if (item.status === "cancelled" || item.fields === null || stale) {
      statements.push(deleteEventStatement(db, row.user_id, row.calendar_id, item.id, guard));
      continue;
    }
    statements.push(
      upsertEventStatement(
        db,
        row.user_id,
        row.calendar_id,
        item as SyncedEvent & { fields: EventFields },
        generation,
        now,
        guard,
      ),
    );
  }
  return statements;
}

export type ForcePollResult = "accepted" | "running" | "cooldown" | "not_connected";
export const FORCE_POLL_COOLDOWN_MS = 60_000;

/**
 * Requests an immediate read from Google for all the user's calendars. Repeated
 * presses within the cooldown, or while a sync runs, are coalesced.
 */
export async function requestForcePoll(
  db: D1Database,
  userId: string,
  now: number,
): Promise<ForcePollResult> {
  const state = await db
    .prepare(
      `SELECT u.force_poll_at,
         (SELECT status FROM google_connections WHERE user_id = u.id) AS connection,
         (SELECT COUNT(*) FROM calendar_sync WHERE user_id = u.id AND lease_expires_at > ?2) AS running,
         (SELECT COUNT(*) FROM calendar_sync WHERE user_id = u.id) AS calendars
       FROM users u WHERE u.id = ?1`,
    )
    .bind(userId, now)
    .first<{
      force_poll_at: number | null;
      connection: string | null;
      running: number;
      calendars: number;
    }>();
  if (state?.connection !== "active" || state.calendars === 0) return "not_connected";
  if (state.running > 0) return "running";
  if (state.force_poll_at !== null && now - state.force_poll_at < FORCE_POLL_COOLDOWN_MS) {
    return "cooldown";
  }
  const [, marked] = await db.batch([
    db.prepare("UPDATE calendar_sync SET next_sync_at = ?1 WHERE user_id = ?2").bind(now, userId),
    db
      .prepare(
        "UPDATE users SET force_poll_at = ?1 WHERE id = ?2 AND (force_poll_at IS NULL OR force_poll_at <= ?3)",
      )
      .bind(now, userId, now - FORCE_POLL_COOLDOWN_MS),
  ]);
  return marked?.meta.changes === 1 ? "accepted" : "cooldown";
}

export interface SyncSummary {
  /** Oldest last-success time across the user's calendars (null if any never succeeded). */
  lastSuccessAt: number | null;
  failingCalendars: number;
  maxConsecutiveFailures: number;
  lastErrorClass: string | null;
  calendars: number;
}

export async function syncSummary(db: D1Database, userId: string): Promise<SyncSummary> {
  const { results } = await db
    .prepare(
      `SELECT last_success_at, consecutive_failures, last_error_class FROM calendar_sync
       WHERE user_id = ?`,
    )
    .bind(userId)
    .all<{
      last_success_at: number | null;
      consecutive_failures: number;
      last_error_class: string | null;
    }>();
  const failing = results.filter((r) => r.consecutive_failures > 0);
  const worst = [...failing].sort((a, b) => b.consecutive_failures - a.consecutive_failures)[0];
  return {
    lastSuccessAt: results.some((r) => r.last_success_at === null)
      ? null
      : Math.min(...results.map((r) => r.last_success_at ?? 0)),
    failingCalendars: failing.length,
    maxConsecutiveFailures: worst?.consecutive_failures ?? 0,
    lastErrorClass: worst?.last_error_class ?? null,
    calendars: results.length,
  };
}
