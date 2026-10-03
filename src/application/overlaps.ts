import type { CalendarSyncSource } from "../calendar/port";
import type { EventTime } from "../domain/calendar-event";

export interface Overlap {
  summary: string;
  start: EventTime;
  end: EventTime;
}

/** At most this many overlaps are listed in a reply. */
const MAX_OVERLAPS = 5;

/**
 * Timed events in the given calendars overlapping [start, end), read directly
 * from Google. Events marked free (including task deadline markers), declined
 * invitations, and the event itself are not conflicts. Returns null when any
 * calendar could not be read, so a reply never claims "no overlaps" falsely.
 */
export async function findOverlaps(
  source: CalendarSyncSource,
  calendarIds: readonly string[],
  start: number,
  end: number,
  excludeEventId: string,
): Promise<Overlap[] | null> {
  const found: (Overlap & { at: number })[] = [];
  for (const calendarId of calendarIds) {
    const listed = await source.listWindow(calendarId, start, end);
    if (!listed.ok) return null;
    for (const item of listed.value) {
      if (item.id === excludeEventId || item.recurringEventId === excludeEventId) continue;
      if (item.status === "cancelled" || item.transparent || item.declined || !item.fields)
        continue;
      const { start: s, end: e } = item.fields;
      if (!("dateTime" in s) || !("dateTime" in e)) continue; // all-day: not a time conflict
      const from = Date.parse(s.dateTime);
      const to = Date.parse(e.dateTime);
      if (from < end && to > start)
        found.push({ summary: item.fields.summary, start: s, end: e, at: from });
    }
  }
  return found
    .sort((a, b) => a.at - b.at)
    .slice(0, MAX_OVERLAPS)
    .map(({ at: _at, ...overlap }) => overlap);
}

export function canCheckOverlaps(calendar: object): calendar is CalendarSyncSource {
  return "listWindow" in calendar;
}
