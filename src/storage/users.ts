import type { IdGenerator } from "../shared/ids";
import { type Guard, unguarded } from "./guard";

export const SETUP_STEPS = [
  "connect",
  "calendars",
  "default",
  "task_calendar",
  "timezone",
  "done",
] as const;

export type SetupStep = (typeof SETUP_STEPS)[number];

export interface UserRecord {
  id: string;
  telegramUserId: number;
  privateChatId: number;
  timezone: string;
  status: "active" | "disabled";
  setupStep: SetupStep;
  defaultCalendarId: string | null;
  taskCalendarId: string | null;
  /** Typing hints shown after guided creations (they stop after a few). */
  typingHintsShown: number;
  /** Earlier timezones, newest first. */
  recentTimezones: string[];
  /** Local hour of the daily agenda (6–11). */
  agendaHour: number;
  /** Default minutes before timed events and exact deadlines to remind. */
  reminderMinutes: number;
  /** Local hour of the evening preview of tomorrow, or null when off. */
  eveningHour: number | null;
  /** Nightly quiet hours (local start and end hours), or null when off. */
  quietHours: { start: number; end: number } | null;
}

interface UserRow {
  id: string;
  telegram_user_id: number;
  private_chat_id: number;
  timezone: string;
  status: "active" | "disabled";
  setup_step: SetupStep;
  default_calendar_id: string | null;
  task_calendar_id: string | null;
  typing_hints_shown: number;
  recent_timezones: string;
  agenda_hour: number;
  reminder_minutes: number;
  evening_hour: number | null;
  quiet_start: number | null;
  quiet_end: number | null;
}

function toRecord(row: UserRow): UserRecord {
  return {
    id: row.id,
    telegramUserId: row.telegram_user_id,
    privateChatId: row.private_chat_id,
    timezone: row.timezone,
    status: row.status,
    setupStep: row.setup_step,
    defaultCalendarId: row.default_calendar_id,
    taskCalendarId: row.task_calendar_id,
    typingHintsShown: row.typing_hints_shown,
    recentTimezones: parseZones(row.recent_timezones),
    agendaHour: row.agenda_hour,
    reminderMinutes: row.reminder_minutes,
    eveningHour: row.evening_hour,
    quietHours:
      row.quiet_start === null || row.quiet_end === null
        ? null
        : { start: row.quiet_start, end: row.quiet_end },
  };
}

const COLUMNS = `id, telegram_user_id, private_chat_id, timezone, status, setup_step,
  default_calendar_id, task_calendar_id, typing_hints_shown, recent_timezones, agenda_hour,
  reminder_minutes, evening_hour, quiet_start, quiet_end`;

function parseZones(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((z): z is string => typeof z === "string") : [];
  } catch {
    return [];
  }
}

/** Creates the user on first contact, or refreshes the private chat ID. */
export function upsertUserStatement(
  db: D1Database,
  ids: IdGenerator,
  telegramUserId: number,
  privateChatId: number,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO users (id, telegram_user_id, private_chat_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (telegram_user_id) DO UPDATE SET
         private_chat_id = excluded.private_chat_id,
         updated_at = excluded.updated_at
       WHERE users.private_chat_id <> excluded.private_chat_id`,
    )
    .bind(ids.next(), telegramUserId, privateChatId, now, now);
}

export async function findUserById(db: D1Database, userId: string): Promise<UserRecord | null> {
  const row = await db
    .prepare(`SELECT ${COLUMNS} FROM users WHERE id = ?`)
    .bind(userId)
    .first<UserRow>();
  return row ? toRecord(row) : null;
}

export async function findUserByTelegramId(
  db: D1Database,
  telegramUserId: number,
): Promise<UserRecord | null> {
  const row = await db
    .prepare(`SELECT ${COLUMNS} FROM users WHERE telegram_user_id = ?`)
    .bind(telegramUserId)
    .first<UserRow>();
  return row ? toRecord(row) : null;
}

/** Moves setup forward only from the expected step, so replays cannot rewind it. */
export function advanceSetupStatement(
  db: D1Database,
  userId: string,
  from: SetupStep,
  to: SetupStep,
  now: number,
  guard: Guard = unguarded,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE users SET setup_step = ?, updated_at = ?
       WHERE id = ? AND setup_step = ? AND ${guard.sql}`,
    )
    .bind(to, now, userId, from, ...guard.params);
}

export function setUserCalendarStatement(
  db: D1Database,
  userId: string,
  role: "default" | "task",
  calendarId: string,
  now: number,
  guard: Guard = unguarded,
): D1PreparedStatement {
  const column = role === "default" ? "default_calendar_id" : "task_calendar_id";
  return db
    .prepare(`UPDATE users SET ${column} = ?, updated_at = ? WHERE id = ? AND ${guard.sql}`)
    .bind(calendarId, now, userId, ...guard.params);
}

/**
 * Changes the timezone used for future interpretation and local schedules.
 * Existing event instants and series keep their own stored timezones.
 */
export function setTimezoneStatement(
  db: D1Database,
  userId: string,
  timezone: string,
  now: number,
  recent: readonly string[] = [],
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE users SET timezone = ?, recent_timezones = ?, settings_version = settings_version + 1,
         updated_at = ? WHERE id = ?`,
    )
    .bind(timezone, JSON.stringify(recent), now, userId);
}

/** Counts one typing hint shown, up to `limit`. */
export function countTypingHintStatement(
  db: D1Database,
  userId: string,
  limit: number,
): D1PreparedStatement {
  return db
    .prepare(
      "UPDATE users SET typing_hints_shown = typing_hints_shown + 1 WHERE id = ? AND typing_hints_shown < ?",
    )
    .bind(userId, limit);
}

/** Users whose reminders or agenda may be due, earliest first. */
export async function usersDueForReminders(
  db: D1Database,
  now: number,
  limit: number,
): Promise<{ id: string; dueVersion: number }[]> {
  const { results } = await db
    .prepare(
      `SELECT id, due_version FROM users
       WHERE setup_step = 'done' AND status = 'active'
         AND (next_due_at IS NULL OR next_due_at <= ?)
       ORDER BY COALESCE(next_due_at, 0) LIMIT ?`,
    )
    .bind(now, limit)
    .all<{ id: string; due_version: number }>();
  return results.map((r) => ({ id: r.id, dueVersion: r.due_version }));
}

/**
 * Stores when the user next needs the reminder pass, unless something changed
 * since `dueVersion` was read (that change cleared it, and must win).
 */
export function setNextDueStatement(
  db: D1Database,
  userId: string,
  at: number,
  dueVersion: number,
): D1PreparedStatement {
  return db
    .prepare("UPDATE users SET next_due_at = ? WHERE id = ? AND due_version = ?")
    .bind(at, userId, dueVersion);
}

/** Agenda hours a user can choose; outside these, the late-agenda rules would overlap. */
export const AGENDA_HOURS = [6, 7, 8, 9, 10, 11] as const;
/** Evening preview hours a user can choose. */
export const EVENING_HOURS = [18, 19, 20, 21, 22] as const;
/** Quiet-hour windows a user can choose (local start and end hours). */
export const QUIET_HOURS = [
  { start: 22, end: 7 },
  { start: 23, end: 7 },
  { start: 22, end: 8 },
  { start: 23, end: 8 },
] as const;

export function setQuietHoursStatement(
  db: D1Database,
  userId: string,
  quiet: { start: number; end: number } | null,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE users SET quiet_start = ?, quiet_end = ?, settings_version = settings_version + 1,
         updated_at = ? WHERE id = ?`,
    )
    .bind(quiet?.start ?? null, quiet?.end ?? null, now, userId);
}

/** Default reminder leads a user can choose, in minutes. */
export const REMINDER_LEADS = [10, 30, 60, 120] as const;

export function setScheduleSettingStatement(
  db: D1Database,
  userId: string,
  setting: { agendaHour: number } | { reminderMinutes: number } | { eveningHour: number | null },
  now: number,
): D1PreparedStatement {
  const [column, value] =
    "agendaHour" in setting
      ? ["agenda_hour", setting.agendaHour]
      : "reminderMinutes" in setting
        ? ["reminder_minutes", setting.reminderMinutes]
        : ["evening_hour", setting.eveningHour];
  return db
    .prepare(
      `UPDATE users SET ${column} = ?, settings_version = settings_version + 1, updated_at = ?
       WHERE id = ?`,
    )
    .bind(value, now, userId);
}
