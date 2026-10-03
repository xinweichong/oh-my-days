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
  };
}

const COLUMNS = `id, telegram_user_id, private_chat_id, timezone, status, setup_step,
  default_calendar_id, task_calendar_id`;

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
