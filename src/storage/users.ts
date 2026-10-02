import type { IdGenerator } from "../shared/ids";

export interface UserRecord {
  id: string;
  telegramUserId: number;
  privateChatId: number;
  timezone: string;
  status: "active" | "disabled";
}

interface UserRow {
  id: string;
  telegram_user_id: number;
  private_chat_id: number;
  timezone: string;
  status: "active" | "disabled";
}

function toRecord(row: UserRow): UserRecord {
  return {
    id: row.id,
    telegramUserId: row.telegram_user_id,
    privateChatId: row.private_chat_id,
    timezone: row.timezone,
    status: row.status,
  };
}

const COLUMNS = "id, telegram_user_id, private_chat_id, timezone, status";

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
