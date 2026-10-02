/** Small read helpers for asserting persisted state in tests. */

export async function rows<T = Record<string, unknown>>(
  db: D1Database,
  sql: string,
  ...params: unknown[]
): Promise<T[]> {
  const { results } = await db
    .prepare(sql)
    .bind(...params)
    .all<T>();
  return results;
}

export async function count(db: D1Database, table: string, where = "1"): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
