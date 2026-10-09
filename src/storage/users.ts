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
  };
}

const COLUMNS = `id, telegram_user_id, private_chat_id, timezone, status, setup_step,
  default_calendar_id, task_calendar_id, typing_hints_shown`;

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
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE users SET timezone = ?, settings_version = settings_version + 1, updated_at = ?
       WHERE id = ?`,
    )
    .bind(timezone, now, userId);
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
