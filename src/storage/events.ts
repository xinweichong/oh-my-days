import type { SyncedEvent } from "../calendar/port";
import type { EventFields, EventTime } from "../domain/calendar-event";
import type { Guard } from "./guard";

export interface CachedEvent {
  calendarId: string;
  eventId: string;
  etag: string;
  fields: EventFields;
  recurring: boolean;
  recurringEventId: string | null;
  transparent: boolean;
  declined: boolean;
  hasGuests: boolean;
  organizerSelf: boolean;
  /** Guest addresses, when read live from Google (not kept in the cache). */
  attendees?: string[];
}

interface CachedRow {
  calendar_id: string;
  event_id: string;
  etag: string;
  summary: string;
  start_json: string;
  end_json: string;
  recurring: number;
  recurring_event_id: string | null;
  transparent: number;
  declined: number;
  has_guests: number;
  organizer_self: number;
}

const COLUMNS = `calendar_id, event_id, etag, summary, start_json, end_json, recurring,
  recurring_event_id, transparent, declined, has_guests, organizer_self`;

function toCached(row: CachedRow): CachedEvent {
  return {
    calendarId: row.calendar_id,
    eventId: row.event_id,
    etag: row.etag,
    fields: {
      summary: row.summary,
      start: JSON.parse(row.start_json) as EventTime,
      end: JSON.parse(row.end_json) as EventTime,
    },
    recurring: row.recurring === 1,
    recurringEventId: row.recurring_event_id,
    transparent: row.transparent === 1,
    declined: row.declined === 1,
    hasGuests: row.has_guests === 1,
    organizerSelf: row.organizer_self === 1,
  };
}

/** The instant/date columns for an event: timed events by instant, all-day by local date. */
function timeColumns(
  fields: EventFields,
): [number | null, number | null, string | null, string | null] {
  if ("date" in fields.start && "date" in fields.end) {
    return [null, null, fields.start.date, fields.end.date];
  }
  const start = "dateTime" in fields.start ? Date.parse(fields.start.dateTime) : NaN;
  const end = "dateTime" in fields.end ? Date.parse(fields.end.dateTime) : NaN;
  return [start, end, null, null];
}

/** Last instant an event can be relevant at (end of an all-day range is generous). */
export function eventEndsAt(fields: EventFields): number {
  const [, endsAt, , endDate] = timeColumns(fields);
  return endsAt ?? Date.parse(`${endDate}T23:59:59Z`) + 14 * 3_600_000;
}

export function upsertEventStatement(
  db: D1Database,
  userId: string,
  calendarId: string,
  event: SyncedEvent & { fields: EventFields },
  generation: number,
  now: number,
  guard: Guard,
): D1PreparedStatement {
  const [startsAt, endsAt, startDate, endDate] = timeColumns(event.fields);
  return db
    .prepare(
      `INSERT INTO event_cache (user_id, calendar_id, event_id, etag, summary, start_json, end_json,
         starts_at, ends_at, start_date, end_date, recurring, recurring_event_id, transparent,
         declined, has_guests, organizer_self, generation, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard.sql}
       ON CONFLICT (user_id, calendar_id, event_id) DO UPDATE SET
         etag = excluded.etag, summary = excluded.summary, start_json = excluded.start_json,
         end_json = excluded.end_json, starts_at = excluded.starts_at, ends_at = excluded.ends_at,
         start_date = excluded.start_date, end_date = excluded.end_date,
         recurring = excluded.recurring, recurring_event_id = excluded.recurring_event_id,
         transparent = excluded.transparent, declined = excluded.declined,
         has_guests = excluded.has_guests, organizer_self = excluded.organizer_self,
         generation = excluded.generation, updated_at = excluded.updated_at`,
    )
    .bind(
      userId,
      calendarId,
      event.id,
      event.etag,
      event.fields.summary,
      JSON.stringify(event.fields.start),
      JSON.stringify(event.fields.end),
      startsAt,
      endsAt,
      startDate,
      endDate,
      event.recurring ? 1 : 0,
      event.recurringEventId,
      event.transparent ? 1 : 0,
      event.declined ? 1 : 0,
      event.hasGuests ? 1 : 0,
      event.organizerSelf ? 1 : 0,
      generation,
      now,
      ...guard.params,
    );
}

export function deleteEventStatement(
  db: D1Database,
  userId: string,
  calendarId: string,
  eventId: string,
  guard: Guard,
): D1PreparedStatement {
  return db
    .prepare(
      `DELETE FROM event_cache WHERE user_id = ? AND calendar_id = ? AND event_id = ? AND ${guard.sql}`,
    )
    .bind(userId, calendarId, eventId, ...guard.params);
}

/** After a complete full resync, rows the provider no longer returned are gone. */
export function deleteStaleGenerationStatement(
  db: D1Database,
  userId: string,
  calendarId: string,
  generation: number,
  guard: Guard,
): D1PreparedStatement {
  return db
    .prepare(
      `DELETE FROM event_cache WHERE user_id = ? AND calendar_id = ? AND generation < ? AND ${guard.sql}`,
    )
    .bind(userId, calendarId, generation, ...guard.params);
}

export async function findCachedEvent(
  db: D1Database,
  userId: string,
  calendarId: string,
  eventId: string,
): Promise<CachedEvent | null> {
  const row = await db
    .prepare(
      `SELECT ${COLUMNS} FROM event_cache WHERE user_id = ? AND calendar_id = ? AND event_id = ?`,
    )
    .bind(userId, calendarId, eventId)
    .first<CachedRow>();
  return row ? toCached(row) : null;
}

/**
 * Events from the given calendars overlapping [from, to) for timed events or
 * [fromDate, toDate) for all-day events, ordered by start.
 */
export async function listCachedEvents(
  db: D1Database,
  userId: string,
  range: { from: number; to: number; fromDate: string; toDate: string },
  calendarIds: readonly string[],
  limit: number,
): Promise<CachedEvent[]> {
  if (calendarIds.length === 0) return [];
  const placeholders = calendarIds.map(() => "?").join(", ");
  const { results } = await db
    .prepare(
      `SELECT ${COLUMNS} FROM event_cache
       WHERE user_id = ? AND calendar_id IN (${placeholders}) AND recurring = 0 AND (
         (starts_at < ? AND ends_at > ?) OR (start_date < ? AND end_date > ?))
       ORDER BY COALESCE(start_date, ''), starts_at LIMIT ?`,
    )
    .bind(userId, ...calendarIds, range.to, range.from, range.toDate, range.fromDate, limit)
    .all<CachedRow>();
  return results.map(toCached);
}

/**
 * Records the result of the bot's own successful write so views reflect it
 * before the next sync. Only tracked calendars are cached; attributes the bot
 * does not change (guests, transparency) are preserved on update.
 */
export function cacheOwnWriteStatement(
  db: D1Database,
  userId: string,
  calendarId: string,
  eventId: string,
  etag: string,
  fields: EventFields,
  now: number,
  guard: Guard,
): D1PreparedStatement {
  const [startsAt, endsAt, startDate, endDate] = timeColumns(fields);
  return db
    .prepare(
      `INSERT INTO event_cache (user_id, calendar_id, event_id, etag, summary, start_json, end_json,
         starts_at, ends_at, start_date, end_date, generation, updated_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, s.generation, ?12
       FROM calendar_sync s WHERE s.user_id = ?1 AND s.calendar_id = ?2 AND ${guard.sql}
       ON CONFLICT (user_id, calendar_id, event_id) DO UPDATE SET
         etag = excluded.etag, summary = excluded.summary, start_json = excluded.start_json,
         end_json = excluded.end_json, starts_at = excluded.starts_at, ends_at = excluded.ends_at,
         start_date = excluded.start_date, end_date = excluded.end_date,
         updated_at = excluded.updated_at`,
    )
    .bind(
      userId,
      calendarId,
      eventId,
      etag,
      fields.summary,
      JSON.stringify(fields.start),
      JSON.stringify(fields.end),
      startsAt,
      endsAt,
      startDate,
      endDate,
      now,
      ...guard.params,
    );
}
