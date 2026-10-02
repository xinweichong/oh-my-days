import type { Guard } from "./guard";

export type CallbackAction = "confirm" | "cancel" | "undo";

export interface CallbackRef {
  token: string;
  userId: string;
  operationId: string;
  action: CallbackAction;
  previewHash: string | null;
  expiresAt: number;
  usedAt: number | null;
  usedBy: string | null;
}

interface CallbackRefRow {
  token: string;
  user_id: string;
  operation_id: string;
  action: CallbackAction;
  preview_hash: string | null;
  expires_at: number;
  used_at: number | null;
  used_by: string | null;
}

export function insertCallbackRefStatement(
  db: D1Database,
  ref: Omit<CallbackRef, "usedAt" | "usedBy">,
  now: number,
  guard: Guard,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO callback_refs
         (token, user_id, operation_id, action, preview_hash, expires_at, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${guard.sql}`,
    )
    .bind(
      ref.token,
      ref.userId,
      ref.operationId,
      ref.action,
      ref.previewHash,
      ref.expiresAt,
      now,
      ...guard.params,
    );
}

/** Looks up a token for its owner only; another user's token is indistinguishable from none. */
export async function findCallbackRef(
  db: D1Database,
  userId: string,
  token: string,
): Promise<CallbackRef | null> {
  const row = await db
    .prepare(
      `SELECT token, user_id, operation_id, action, preview_hash, expires_at, used_at, used_by
       FROM callback_refs WHERE token = ? AND user_id = ?`,
    )
    .bind(token, userId)
    .first<CallbackRefRow>();
  if (!row) return null;
  return {
    token: row.token,
    userId: row.user_id,
    operationId: row.operation_id,
    action: row.action,
    previewHash: row.preview_hash,
    expiresAt: row.expires_at,
    usedAt: row.used_at,
    usedBy: row.used_by,
  };
}

/**
 * Marks the token used by `usedBy`, and retires the operation's other unused
 * tokens (e.g. Cancel once Confirm is pressed). Returns the guard that holds only
 * if this consumption won.
 */
export function consumeCallbackRefStatements(
  db: D1Database,
  ref: CallbackRef,
  usedBy: string,
  now: number,
): { statements: D1PreparedStatement[]; guard: Guard } {
  const guard: Guard = {
    sql: "EXISTS (SELECT 1 FROM callback_refs WHERE token = ? AND used_by = ?)",
    params: [ref.token, usedBy],
  };
  return {
    guard,
    statements: [
      db
        .prepare(
          `UPDATE callback_refs SET used_at = ?, used_by = ?
           WHERE token = ? AND user_id = ? AND used_at IS NULL AND expires_at > ?`,
        )
        .bind(now, usedBy, ref.token, ref.userId, now),
      db
        .prepare(
          `UPDATE callback_refs SET used_at = ?, used_by = ?
           WHERE operation_id = ? AND user_id = ? AND used_at IS NULL AND action <> 'undo'
             AND ${guard.sql}`,
        )
        .bind(now, `retired:${usedBy}`, ref.operationId, ref.userId, ...guard.params),
    ],
  };
}

export function purgeExpiredCallbackRefsStatement(
  db: D1Database,
  olderThan: number,
  limit: number,
): D1PreparedStatement {
  return db
    .prepare(
      `DELETE FROM callback_refs WHERE token IN (
         SELECT token FROM callback_refs WHERE expires_at < ? LIMIT ?)`,
    )
    .bind(olderThan, limit);
}
