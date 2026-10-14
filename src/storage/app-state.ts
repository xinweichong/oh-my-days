/** Application-wide values in `app_state` that are not owned by any user. */

const LAST_TICK = "tick:last";

/** The scheduler counts as stalled when no tick has finished for this long. */
export const MAX_TICK_AGE_MS = 10 * 60_000;

/** Records the end of a scheduled tick; liveness checks read it. */
export function recordTickStatement(db: D1Database, now: number): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO app_state (key, value, updated_at) VALUES (?1, ?2, ?2)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(LAST_TICK, now);
}

/** When the last scheduled tick finished, or null if none has. */
export async function lastTickAt(db: D1Database): Promise<number | null> {
  const row = await db
    .prepare("SELECT value FROM app_state WHERE key = ?")
    .bind(LAST_TICK)
    .first<{ value: string }>();
  return row ? Number(row.value) : null;
}
