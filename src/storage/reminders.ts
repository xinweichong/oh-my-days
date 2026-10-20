import type { EventDisplay } from "../calendar/port";
import {
  decodeRules,
  encodeRule,
  type ReminderAnchor,
  type ReminderRule,
} from "../domain/reminders";
import { type Guard, unguarded } from "./guard";

export interface HorizonEvent {
  calendarId: string;
  eventId: string;
  summary: string;
  startsAt: number;
  endsAt: number;
  declined: boolean;
  /** Shown in reminders only. */
  display: EventDisplay;
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
  // Upsert, then drop rows this refresh didn't see: unchanged occurrences are
  // left alone, so only new or moved ones mark the user's next due time stale.
  return [
    ...events.map((e) =>
      db
        .prepare(
          `INSERT INTO event_horizon (user_id, calendar_id, event_id, summary, starts_at, ends_at,
             declined, location, call_url, html_link, refreshed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (user_id, calendar_id, event_id) DO UPDATE SET summary = excluded.summary,
             starts_at = excluded.starts_at, ends_at = excluded.ends_at,
             declined = excluded.declined, location = excluded.location,
             call_url = excluded.call_url, html_link = excluded.html_link,
             refreshed_at = excluded.refreshed_at`,
        )
        .bind(
          userId,
          e.calendarId,
          e.eventId,
          e.summary,
          e.startsAt,
          e.endsAt,
          e.declined ? 1 : 0,
          e.display.location,
          e.display.callUrl,
          e.display.htmlLink,
          now,
        ),
    ),
    db
      .prepare("DELETE FROM event_horizon WHERE user_id = ? AND refreshed_at < ?")
      .bind(userId, now),
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
      `SELECT calendar_id, event_id, summary, starts_at, ends_at, declined, location, call_url,
         html_link FROM event_horizon
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
      location: string | null;
      call_url: string | null;
      html_link: string | null;
    }>();
  return results.map((r) => ({
    calendarId: r.calendar_id,
    eventId: r.event_id,
    summary: r.summary,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    declined: r.declined === 1,
    display: { location: r.location, callUrl: r.call_url, htmlLink: r.html_link },
  }));
}

/** Marks the user's horizon for rebuilding on the next tick (e.g. after sync saw changes). */
export function invalidateHorizonStatement(db: D1Database, userId: string): D1PreparedStatement {
  return db.prepare("UPDATE users SET horizon_refreshed_at = NULL WHERE id = ?").bind(userId);
}

// --- Per-item reminders ----------------------------------------------------------------

export type TargetKind = "event" | "task";

/** An item's own reminders, replacing the default (ADR 0008). */
export interface ReminderSetting {
  /** Empty means no reminders for this item. */
  rules: ReminderRule[];
  /** Events only: the start, or all-day date, when the reminders were set. */
  anchor: ReminderAnchor | null;
  /** Doubles as the setting's version for conditional writes. */
  updatedAt: number;
}

interface SettingRow {
  target_kind: TargetKind;
  target_key: string;
  minutes_before: number | null;
  rules: string | null;
  anchor_at: number | null;
  anchor_date: string | null;
  updated_at: number;
}

const SETTING_COLUMNS =
  "target_kind, target_key, minutes_before, rules, anchor_at, anchor_date, updated_at";

function toSetting(row: SettingRow): ReminderSetting {
  let rules: ReminderRule[];
  if (row.rules === null) {
    // Written before several reminders existed: one lead time, or none.
    rules = row.minutes_before === null ? [] : [{ kind: "before", minutes: row.minutes_before }];
  } else {
    let codes: unknown = [];
    try {
      codes = JSON.parse(row.rules);
    } catch {
      codes = [];
    }
    rules = decodeRules(Array.isArray(codes) ? codes : []);
  }
  const anchor: ReminderAnchor | null =
    row.anchor_at !== null
      ? { kind: "instant", at: row.anchor_at }
      : row.anchor_date !== null
        ? { kind: "date", date: row.anchor_date }
        : null;
  return { rules, anchor, updatedAt: row.updated_at };
}

/** Both kinds in one read: per kind, settings by target key. */
export async function allReminderSettings(
  db: D1Database,
  userId: string,
): Promise<Record<TargetKind, Map<string, ReminderSetting>>> {
  const { results } = await db
    .prepare(`SELECT ${SETTING_COLUMNS} FROM reminder_overrides WHERE user_id = ?`)
    .bind(userId)
    .all<SettingRow>();
  const out: Record<TargetKind, Map<string, ReminderSetting>> = {
    event: new Map(),
    task: new Map(),
  };
  for (const r of results) out[r.target_kind].set(r.target_key, toSetting(r));
  return out;
}

/** Settings of one kind by target key. Absent keys use the default. */
export async function reminderSettings(
  db: D1Database,
  userId: string,
  kind: TargetKind,
): Promise<Map<string, ReminderSetting>> {
  const { results } = await db
    .prepare(
      `SELECT ${SETTING_COLUMNS} FROM reminder_overrides WHERE user_id = ? AND target_kind = ?`,
    )
    .bind(userId, kind)
    .all<SettingRow>();
  return new Map(results.map((r) => [r.target_key, toSetting(r)]));
}

export async function findReminderSetting(
  db: D1Database,
  userId: string,
  kind: TargetKind,
  targetKey: string,
): Promise<ReminderSetting | null> {
  const row = await db
    .prepare(
      `SELECT ${SETTING_COLUMNS} FROM reminder_overrides
       WHERE user_id = ? AND target_kind = ? AND target_key = ?`,
    )
    .bind(userId, kind, targetKey)
    .first<SettingRow>();
  return row ? toSetting(row) : null;
}

/** Holds while the item's setting is still the version that was read (0: none). */
export function reminderVersionGuard(
  userId: string,
  kind: TargetKind,
  targetKey: string,
  version: number,
): Guard {
  return {
    sql: `COALESCE((SELECT updated_at FROM reminder_overrides
             WHERE user_id = ? AND target_kind = ? AND target_key = ?), 0) = ?`,
    params: [userId, kind, targetKey, version],
  };
}

/** Replaces an item's reminders. An empty list means none. */
export function setRemindersStatement(
  db: D1Database,
  userId: string,
  kind: TargetKind,
  targetKey: string,
  rules: readonly ReminderRule[],
  anchor: ReminderAnchor | null,
  now: number,
  guard: Guard = unguarded,
): D1PreparedStatement {
  const leads = rules.flatMap((r) => (r.kind === "before" ? [r.minutes] : []));
  const shortest = leads.length ? Math.min(...leads) : null;
  return db
    .prepare(
      `INSERT INTO reminder_overrides
         (user_id, target_kind, target_key, minutes_before, rules, anchor_at, anchor_date, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard.sql}
       ON CONFLICT (user_id, target_kind, target_key) DO UPDATE SET
         minutes_before = excluded.minutes_before, rules = excluded.rules,
         anchor_at = excluded.anchor_at, anchor_date = excluded.anchor_date,
         updated_at = excluded.updated_at`,
    )
    .bind(
      userId,
      kind,
      targetKey,
      shortest,
      JSON.stringify(rules.map(encodeRule)),
      anchor?.kind === "instant" ? anchor.at : null,
      anchor?.kind === "date" ? anchor.date : null,
      now,
      ...guard.params,
    );
}

/** Back to the default reminders. */
export function clearRemindersStatement(
  db: D1Database,
  userId: string,
  kind: TargetKind,
  targetKey: string,
  guard: Guard = unguarded,
): D1PreparedStatement {
  return db
    .prepare(
      `DELETE FROM reminder_overrides
       WHERE user_id = ? AND target_kind = ? AND target_key = ? AND ${guard.sql}`,
    )
    .bind(userId, kind, targetKey, ...guard.params);
}

/** Records an event's new start, found when a reminder for it was revalidated. */
export function reanchorStatement(
  db: D1Database,
  userId: string,
  targetKey: string,
  anchor: ReminderAnchor,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE reminder_overrides SET anchor_at = ?, anchor_date = ?
       WHERE user_id = ? AND target_kind = 'event' AND target_key = ?`,
    )
    .bind(
      anchor.kind === "instant" ? anchor.at : null,
      anchor.kind === "date" ? anchor.date : null,
      userId,
      targetKey,
    );
}

/** Event reminder settings for events that are over (by their kept start). */
export function purgePastEventRemindersStatement(
  db: D1Database,
  before: number,
  beforeDate: string,
  limit: number,
): D1PreparedStatement {
  return db
    .prepare(
      `DELETE FROM reminder_overrides WHERE rowid IN (
         SELECT rowid FROM reminder_overrides WHERE target_kind = 'event'
           AND (anchor_at < ? OR anchor_date < ?) LIMIT ?)`,
    )
    .bind(before, beforeDate, limit);
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
