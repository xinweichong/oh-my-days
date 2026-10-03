import type { Guard } from "./guard";

export interface UiAction {
  action: string;
  payload: Record<string, unknown>;
}

/** Inserts a button token whose meaning stays on the server. */
export function insertUiActionStatement(
  db: D1Database,
  token: string,
  userId: string,
  action: UiAction,
  expiresAt: number,
  now: number,
  guard: Guard,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO ui_actions (token, user_id, action, payload, expires_at, created_at)
       SELECT ?, ?, ?, ?, ?, ? WHERE ${guard.sql}`,
    )
    .bind(
      token,
      userId,
      action.action,
      JSON.stringify(action.payload),
      expiresAt,
      now,
      ...guard.params,
    );
}

/** Finds an unexpired token for its owner; another user's token reads as absent. */
export async function findUiAction(
  db: D1Database,
  userId: string,
  token: string,
  now: number,
): Promise<UiAction | null> {
  const row = await db
    .prepare(
      "SELECT action, payload FROM ui_actions WHERE token = ? AND user_id = ? AND expires_at > ?",
    )
    .bind(token, userId, now)
    .first<{ action: string; payload: string }>();
  return row ? { action: row.action, payload: JSON.parse(row.payload) } : null;
}

export type PendingInputKind = "new_default_calendar_name" | "timezone";

export function setPendingInputStatement(
  db: D1Database,
  userId: string,
  kind: PendingInputKind,
  expiresAt: number,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO pending_inputs (user_id, kind, expires_at, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET kind = excluded.kind, expires_at = excluded.expires_at,
         created_at = excluded.created_at`,
    )
    .bind(userId, kind, expiresAt, now);
}

export async function findPendingInput(
  db: D1Database,
  userId: string,
  now: number,
): Promise<PendingInputKind | null> {
  const row = await db
    .prepare("SELECT kind FROM pending_inputs WHERE user_id = ? AND expires_at > ?")
    .bind(userId, now)
    .first<{ kind: PendingInputKind }>();
  return row?.kind ?? null;
}

export function clearPendingInputStatement(db: D1Database, userId: string): D1PreparedStatement {
  return db.prepare("DELETE FROM pending_inputs WHERE user_id = ?").bind(userId);
}

export function purgeExpiredInteractionsStatements(
  db: D1Database,
  now: number,
  limit: number,
): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `DELETE FROM ui_actions WHERE token IN (
           SELECT token FROM ui_actions WHERE expires_at < ? LIMIT ?)`,
      )
      .bind(now, limit),
    db.prepare("DELETE FROM pending_inputs WHERE expires_at < ?").bind(now),
  ];
}
