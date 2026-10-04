import type { Guard } from "./guard";

export interface HorizonEvent {
  calendarId: string;
  eventId: string;
  summary: string;
  startsAt: number;
  endsAt: number;
  declined: boolean;
}

/**
 * Replaces a user's whole horizon from complete listings of every viewed
 * calendar (rows for calendars no longer viewed are dropped).
 */
export function replaceHorizonStatements(
  db: D1Database,
  userId: string,
  events: readonly HorizonEvent[],
  now: number,
): D1PreparedStatement[] {
  return [
    db.prepare("DELETE FROM event_horizon WHERE user_id = ?").bind(userId),
    ...events.map((e) =>
      db
        .prepare(
          `INSERT INTO event_horizon (user_id, calendar_id, event_id, summary, starts_at, ends_at,
             declined, refreshed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (user_id, calendar_id, event_id) DO UPDATE SET summary = excluded.summary,
             starts_at = excluded.starts_at, ends_at = excluded.ends_at,
             declined = excluded.declined, refreshed_at = excluded.refreshed_at`,
        )
        .bind(
          userId,
          e.calendarId,
          e.eventId,
          e.summary,
          e.startsAt,
          e.endsAt,
          e.declined ? 1 : 0,
          now,
        ),
    ),
    db.prepare("UPDATE users SET horizon_refreshed_at = ? WHERE id = ?").bind(now, userId),
  ];
}

export async function horizonEvents(
  db: D1Database,
  userId: string,
  from: number,
  to: number,
): Promise<HorizonEvent[]> {
  const { results } = await db
    .prepare(
      `SELECT calendar_id, event_id, summary, starts_at, ends_at, declined FROM event_horizon
       WHERE user_id = ? AND starts_at > ? AND starts_at <= ? ORDER BY starts_at`,
    )
    .bind(userId, from, to)
    .all<{
      calendar_id: string;
      event_id: string;
      summary: string;
      starts_at: number;
      ends_at: number;
      declined: number;
    }>();
  return results.map((r) => ({
    calendarId: r.calendar_id,
    eventId: r.event_id,
    summary: r.summary,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    declined: r.declined === 1,
  }));
}

/** Marks the user's horizon for rebuilding on the next tick (e.g. after sync saw changes). */
export function invalidateHorizonStatement(db: D1Database, userId: string): D1PreparedStatement {
  return db.prepare("UPDATE users SET horizon_refreshed_at = NULL WHERE id = ?").bind(userId);
}

// --- Overrides --------------------------------------------------------------------

export type TargetKind = "event" | "task";

/** Both kinds of overrides in one read: per kind, minutes by target key. */
export async function allReminderOverrides(
  db: D1Database,
  userId: string,
): Promise<Record<TargetKind, Map<string, number | null>>> {
  const { results } = await db
    .prepare(
      "SELECT target_kind, target_key, minutes_before FROM reminder_overrides WHERE user_id = ?",
    )
    .bind(userId)
    .all<{ target_kind: TargetKind; target_key: string; minutes_before: number | null }>();
  const out: Record<TargetKind, Map<string, number | null>> = { event: new Map(), task: new Map() };
  for (const r of results) out[r.target_kind].set(r.target_key, r.minutes_before);
  return out;
}

/** Override minutes per target key; null means "no reminder". Absent keys use the default. */
export async function reminderOverrides(
  db: D1Database,
  userId: string,
  kind: TargetKind,
): Promise<Map<string, number | null>> {
  const { results } = await db
    .prepare(
      "SELECT target_key, minutes_before FROM reminder_overrides WHERE user_id = ? AND target_kind = ?",
    )
    .bind(userId, kind)
    .all<{ target_key: string; minutes_before: number | null }>();
  return new Map(results.map((r) => [r.target_key, r.minutes_before]));
}

export function setOverrideStatement(
  db: D1Database,
  userId: string,
  kind: TargetKind,
  targetKey: string,
  minutesBefore: number | null,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO reminder_overrides (user_id, target_kind, target_key, minutes_before, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (user_id, target_kind, target_key) DO UPDATE SET
         minutes_before = excluded.minutes_before, updated_at = excluded.updated_at`,
    )
    .bind(userId, kind, targetKey, minutesBefore, now);
}

// --- Reminder log and agenda runs ----------------------------------------------------

export type LogOutcome = "sent" | "skipped" | "confirmed_on_create" | "summarized";

export async function loggedReminderKeys(
  db: D1Database,
  userId: string,
  keys: readonly string[],
): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const placeholders = keys.map(() => "?").join(", ");
  const { results } = await db
    .prepare(
      `SELECT reminder_key FROM reminder_log WHERE user_id = ? AND reminder_key IN (${placeholders})`,
    )
    .bind(userId, ...keys)
    .all<{ reminder_key: string }>();
  return new Set(results.map((r) => r.reminder_key));
}

/** Claims a reminder key; a key already claimed (by anyone) is left alone. */
export function claimReminderStatement(
  db: D1Database,
  userId: string,
  key: string,
  outcome: LogOutcome,
  claimedBy: string,
  now: number,
  guard: Guard,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO reminder_log (user_id, reminder_key, outcome, claimed_by, created_at)
       SELECT ?, ?, ?, ?, ? WHERE ${guard.sql}
       ON CONFLICT (user_id, reminder_key) DO NOTHING`,
    )
    .bind(userId, key, outcome, claimedBy, now, ...guard.params);
}

/** Holds only if this claimer won all `count` of its claims. */
export function allClaimedGuard(userId: string, claimedBy: string, count: number): Guard {
  return {
    sql: "(SELECT COUNT(*) FROM reminder_log WHERE user_id = ? AND claimed_by = ?) = ?",
    params: [userId, claimedBy, count],
  };
}

export function claimAgendaStatement(
  db: D1Database,
  userId: string,
  localDate: string,
  claimedBy: string,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO agenda_runs (user_id, local_date, claimed_by, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id, local_date) DO NOTHING`,
    )
    .bind(userId, localDate, claimedBy, now);
}

export function agendaClaimGuard(userId: string, localDate: string, claimedBy: string): Guard {
  return {
    sql: "EXISTS (SELECT 1 FROM agenda_runs WHERE user_id = ? AND local_date = ? AND claimed_by = ?)",
    params: [userId, localDate, claimedBy],
  };
}

export async function agendaSent(
  db: D1Database,
  userId: string,
  localDate: string,
): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS x FROM agenda_runs WHERE user_id = ? AND local_date = ?")
    .bind(userId, localDate)
    .first();
  return row !== null;
}

export function purgeOldReminderStatements(
  db: D1Database,
  olderThan: number,
  limit: number,
): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `DELETE FROM reminder_log WHERE rowid IN (
           SELECT rowid FROM reminder_log WHERE created_at < ? LIMIT ?)`,
      )
      .bind(olderThan, limit),
    db
      .prepare(
        `DELETE FROM agenda_runs WHERE rowid IN (
           SELECT rowid FROM agenda_runs WHERE created_at < ? LIMIT ?)`,
      )
      .bind(olderThan, limit),
  ];
}
