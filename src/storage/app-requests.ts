/** Idempotency records for Mini App writes (ADR 0005). */

export async function findAppRequest(
  db: D1Database,
  userId: string,
  key: string,
): Promise<Record<string, unknown> | null> {
  const row = await db
    .prepare("SELECT result FROM app_requests WHERE user_id = ? AND request_key = ?")
    .bind(userId, key)
    .first<{ result: string }>();
  return row ? (JSON.parse(row.result) as Record<string, unknown>) : null;
}

/**
 * Records the key, optionally only when `onlyIf` (an SQL condition with its
 * parameters) holds after the batch's earlier statements, so a change that
 * didn't apply leaves no record. A key used before fails the whole batch.
 */
export function recordAppRequestStatement(
  db: D1Database,
  userId: string,
  key: string,
  result: Record<string, unknown>,
  now: number,
  onlyIf: { sql: string; params: unknown[] } = { sql: "1", params: [] },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO app_requests (user_id, request_key, result, created_at)
       SELECT ?, ?, ?, ? WHERE ${onlyIf.sql}`,
    )
    .bind(userId, key, JSON.stringify(result), now, ...onlyIf.params);
}

export function purgeAppRequestsStatement(
  db: D1Database,
  olderThan: number,
  limit: number,
): D1PreparedStatement {
  return db
    .prepare(
      `DELETE FROM app_requests WHERE rowid IN (
         SELECT rowid FROM app_requests WHERE created_at < ? LIMIT ?)`,
    )
    .bind(olderThan, limit);
}
