import type { Frequency } from "../domain/recurrence";
import type { Guard } from "./guard";

export interface SeriesRecord {
  id: string;
  userId: string;
  listId: string;
  title: string;
  freq: Frequency;
  interval: number;
  anchorDate: string;
  dueTime: string | null;
  timezone: string;
  status: "active" | "stopped";
  materializedThrough: string;
  version: number;
}

interface SeriesRow {
  id: string;
  user_id: string;
  list_id: string;
  title: string;
  freq: Frequency;
  interval: number;
  anchor_date: string;
  due_time: string | null;
  timezone: string;
  status: "active" | "stopped";
  materialized_through: string;
  version: number;
}

const COLUMNS = `id, user_id, list_id, title, freq, interval, anchor_date, due_time, timezone, status,
  materialized_through, version`;

function toSeries(row: SeriesRow): SeriesRecord {
  return {
    id: row.id,
    userId: row.user_id,
    listId: row.list_id,
    title: row.title,
    freq: row.freq,
    interval: row.interval,
    anchorDate: row.anchor_date,
    dueTime: row.due_time,
    timezone: row.timezone,
    status: row.status,
    materializedThrough: row.materialized_through,
    version: row.version,
  };
}

export function insertSeriesStatement(
  db: D1Database,
  series: Omit<SeriesRecord, "status" | "version">,
  now: number,
  guard: Guard,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO task_series (id, user_id, list_id, title, freq, interval, anchor_date, due_time,
         timezone, status, materialized_through, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ? WHERE ${guard.sql}`,
    )
    .bind(
      series.id,
      series.userId,
      series.listId,
      series.title,
      series.freq,
      series.interval,
      series.anchorDate,
      series.dueTime,
      series.timezone,
      series.materializedThrough,
      now,
      now,
      ...guard.params,
    );
}

export async function findSeries(
  db: D1Database,
  userId: string,
  seriesId: string,
): Promise<SeriesRecord | null> {
  const row = await db
    .prepare(`SELECT ${COLUMNS} FROM task_series WHERE id = ? AND user_id = ?`)
    .bind(seriesId, userId)
    .first<SeriesRow>();
  return row ? toSeries(row) : null;
}

/** Active series whose materialization lags behind `through`. */
export async function seriesNeedingOccurrences(
  db: D1Database,
  through: (series: SeriesRecord) => string,
  limit: number,
): Promise<SeriesRecord[]> {
  // The horizon depends on each series' zone, so filter after a coarse query.
  const { results } = await db
    .prepare(
      `SELECT ${COLUMNS} FROM task_series WHERE status = 'active'
       ORDER BY materialized_through LIMIT ?`,
    )
    .bind(limit * 4)
    .all<SeriesRow>();
  return results
    .map(toSeries)
    .filter((s) => s.materializedThrough < through(s))
    .slice(0, limit);
}

/** Advances the cursor only from the value this run read, so runs cannot overlap. */
export function advanceSeriesStatement(
  db: D1Database,
  series: SeriesRecord,
  through: string,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE task_series SET materialized_through = ?, updated_at = ?
       WHERE id = ? AND user_id = ? AND materialized_through = ? AND status = 'active'`,
    )
    .bind(through, now, series.id, series.userId, series.materializedThrough);
}

export function seriesCursorGuard(series: SeriesRecord, through: string): Guard {
  return {
    sql: "EXISTS (SELECT 1 FROM task_series WHERE id = ? AND user_id = ? AND materialized_through = ?)",
    params: [series.id, series.userId, through],
  };
}

export function updateSeriesStatement(
  db: D1Database,
  series: SeriesRecord,
  changes: { title?: string; status?: "stopped" },
  now: number,
): D1PreparedStatement {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (changes.title !== undefined) {
    sets.push("title = ?");
    values.push(changes.title);
  }
  if (changes.status !== undefined) {
    sets.push("status = ?");
    values.push(changes.status);
  }
  return db
    .prepare(
      `UPDATE task_series SET ${[...sets, "version = version + 1", "updated_at = ?"].join(", ")}
       WHERE id = ? AND user_id = ? AND version = ?`,
    )
    .bind(...values, now, series.id, series.userId, series.version);
}
