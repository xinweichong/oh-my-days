import { occurrencesBetween, type Recurrence } from "../domain/recurrence";
import type { Deadline } from "../domain/tasks";
import { addDays, localDateAt, zonedInstant } from "../domain/time";
import type { Clock } from "../shared/clock";
import type { IdGenerator } from "../shared/ids";
import { logEvent } from "../shared/log";
import {
  advanceSeriesStatement,
  type SeriesRecord,
  seriesCursorGuard,
  seriesNeedingOccurrences,
} from "../storage/series";
import { insertTaskStatement } from "../storage/tasks";
import { projectTaskStatement } from "./task-projection";

/** Occurrences are materialized this far ahead (ADR 0003). */
export const SERIES_HORIZON_DAYS = 60;
/** Bounds occurrences created per series per run (also bounds outage backfill). */
export const OCCURRENCES_PER_RUN = 31;

export function recurrenceOf(series: SeriesRecord): Recurrence {
  return { freq: series.freq, interval: series.interval, anchor: series.anchorDate };
}

/**
 * The deadline of the occurrence on `date`. A due time skipped by a DST change
 * uses the first valid time after it (RFC 5545), rather than dropping the day.
 */
export function occurrenceDeadline(
  series: Pick<SeriesRecord, "dueTime" | "timezone">,
  date: string,
): Deadline {
  if (!series.dueTime) return { kind: "date", date };
  const exact = zonedInstant(date, series.dueTime, series.timezone);
  if (exact.ok) return { kind: "datetime", at: exact.instant, timeZone: series.timezone };
  const [h, m] = series.dueTime.split(":").map(Number) as [number, number];
  const later = zonedInstant(
    date,
    `${String((h + 1) % 24).padStart(2, "0")}:${String(m).padStart(2, "0")}`,
    series.timezone,
  );
  return later.ok
    ? { kind: "datetime", at: later.instant, timeZone: series.timezone }
    : { kind: "date", date };
}

export interface SeriesDeps {
  db: D1Database;
  clock: Clock;
  ids: IdGenerator;
}

/**
 * Materializes due occurrences for up to `limit` series. Resumes from each
 * series' cursor, so occurrences missed during an outage are still created
 * (older unfinished occurrences stay open and become overdue), a bounded number
 * per run. Overlapping runs cannot duplicate an occurrence.
 */
export async function materializeSeries(deps: SeriesDeps, limit: number): Promise<number> {
  const now = deps.clock.now();
  const horizon = (s: SeriesRecord) => addDays(localDateAt(now, s.timezone), SERIES_HORIZON_DAYS);
  let created = 0;
  for (const series of await seriesNeedingOccurrences(deps.db, horizon, limit)) {
    const through = horizon(series);
    const dates = occurrencesBetween(
      recurrenceOf(series),
      addDays(series.materializedThrough, 1),
      through,
      OCCURRENCES_PER_RUN,
    );
    const reached = dates.length === OCCURRENCES_PER_RUN ? (dates.at(-1) as string) : through;
    const guard = seriesCursorGuard(series, reached);
    const statements: D1PreparedStatement[] = [
      advanceSeriesStatement(deps.db, series, reached, now),
    ];
    for (const date of dates) {
      const id = deps.ids.next();
      statements.push(
        insertTaskStatement(
          deps.db,
          {
            id,
            userId: series.userId,
            listId: series.listId,
            title: series.title,
            deadline: occurrenceDeadline(series, date),
            status: "open",
            origin: "telegram",
            occurrence: { seriesId: series.id, date },
          },
          now,
          guard,
        ),
        projectTaskStatement(
          deps.db,
          deps.ids,
          { id, userId: series.userId, title: series.title },
          1,
          now,
          guard,
        ),
      );
    }
    await deps.db.batch(statements);
    created += dates.length;
    if (dates.length) logEvent("series.materialized", { seriesId: series.id, count: dates.length });
  }
  return created;
}
