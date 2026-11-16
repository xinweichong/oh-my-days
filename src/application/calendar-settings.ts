import { isWritable } from "../calendar/port";
import { type StoredCalendar, setCalendarSelectedStatement } from "../storage/google";
import type { Guard } from "../storage/guard";
import { setUserCalendarStatement, type UserRecord } from "../storage/users";

/**
 * Which calendars are shown, and which one new events go to. Telegram and the
 * Mini App both change these through this module, so the rules are the same.
 * Both changes touch only the application's own records, never Google.
 */

/**
 * Calendars a person can show or hide: listed, with events they can read, and
 * not the task calendar (which is always shown by the application itself).
 * View-only calendars qualify; only the default has to be writable.
 */
export function selectableCalendars(
  user: UserRecord,
  calendars: StoredCalendar[],
): StoredCalendar[] {
  return calendars.filter(
    (c) => c.listed && c.accessRole !== "freeBusyReader" && c.calendarId !== user.taskCalendarId,
  );
}

export const MAX_CALENDAR_NAME = 100;

/**
 * A name for a calendar about to be created: trimmed, not empty, not a command,
 * and not one the person already has (two with the same name could not be told
 * apart in a picker, nor reliably recognized after a lost response).
 */
export function checkCalendarName(
  input: string,
  calendars: StoredCalendar[],
): { ok: true; name: string } | { ok: false; reason: "bad_name" | "name_taken" } {
  const name = input.trim();
  if (name.length === 0 || name.length > MAX_CALENDAR_NAME || name.startsWith("/")) {
    return { ok: false, reason: "bad_name" };
  }
  const taken = calendars.some(
    (c) => c.listed && c.summary.trim().toLowerCase() === name.toLowerCase(),
  );
  return taken ? { ok: false, reason: "name_taken" } : { ok: true, name };
}

export type CalendarChange =
  | {
      ok: true;
      /** The calendar's name, for confirmations. */
      summary: string;
      statements: (db: D1Database, guard: Guard) => D1PreparedStatement[];
    }
  | { ok: false; reason: "unavailable" | "not_writable" | "last_selected" | "is_default" };

/**
 * Makes a calendar the default for new events (and shows it). It must be a
 * listed calendar the user can edit; the task calendar is never offered.
 */
export function planDefaultChange(
  user: UserRecord,
  calendars: StoredCalendar[],
  calendarId: string,
  now: number,
): CalendarChange {
  const target = calendars.find((c) => c.calendarId === calendarId && c.listed);
  if (!target || target.calendarId === user.taskCalendarId) {
    return { ok: false, reason: "unavailable" };
  }
  if (!isWritable(target.accessRole)) return { ok: false, reason: "not_writable" };
  return {
    ok: true,
    summary: target.summary,
    statements: (db, guard) => [
      setUserCalendarStatement(db, user.id, "default", target.calendarId, now, guard),
      setCalendarSelectedStatement(db, user.id, target.calendarId, true, now),
    ],
  };
}

/**
 * Shows or hides a calendar in views, overlap checks, and reminders. Hiding
 * changes nothing in Google and nothing about tasks or events.
 *
 * `keepOne` refuses to hide the last shown calendar, and the default calendar,
 * so a person is never left with new events going somewhere unseen. Telegram's
 * picker passes false and checks the whole selection when it is finished.
 */
export function planSelection(
  user: UserRecord,
  calendars: StoredCalendar[],
  calendarId: string,
  selected: boolean,
  now: number,
  options: { keepOne: boolean },
): CalendarChange {
  const target = selectableCalendars(user, calendars).find((c) => c.calendarId === calendarId);
  if (!target) return { ok: false, reason: "unavailable" };
  if (!selected && options.keepOne) {
    if (target.calendarId === user.defaultCalendarId) return { ok: false, reason: "is_default" };
    const others = selectableCalendars(user, calendars).filter(
      (c) => c.selected && c.calendarId !== target.calendarId,
    );
    if (others.length === 0) return { ok: false, reason: "last_selected" };
  }
  return {
    ok: true,
    summary: target.summary,
    statements: (db) => [
      setCalendarSelectedStatement(db, user.id, target.calendarId, selected, now),
    ],
  };
}
