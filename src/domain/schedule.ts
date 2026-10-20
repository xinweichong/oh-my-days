import type { Deadline } from "./tasks";
import { addDays, type LocalDate, localDateAt, wallPartsAt, weekday, zonedInstant } from "./time";

/** Spec §5: one hour before timed events. */
export const DEFAULT_EVENT_REMINDER_MINUTES = 60;
/** Spec §6: exact-time deadlines are reminded one hour before. */
export const DEFAULT_TASK_REMINDER_MINUTES = 60;
/** Spec §7: the daily agenda at 8am in the user's timezone, unless changed (D1). */
export const AGENDA_HOUR = 8;

/**
 * A date-only task is overdue after the end of its due date in the user's
 * zone; an exact-time task after its due instant.
 */
export function isOverdue(deadline: Deadline, now: number, timeZone: string): boolean {
  if (deadline.kind === "date") return localDateAt(now, timeZone) > deadline.date;
  if (deadline.kind === "datetime") return now > deadline.at;
  return false;
}

/** Whether a deadline falls on the given local date in the user's zone. */
export function isDueOn(deadline: Deadline, date: LocalDate, timeZone: string): boolean {
  if (deadline.kind === "date") return deadline.date === date;
  if (deadline.kind === "datetime") return localDateAt(deadline.at, timeZone) === date;
  return false;
}

/** Monday of the calendar week containing `date` (weeks run Monday–Sunday). */
export function weekStart(date: LocalDate): LocalDate {
  return addDays(date, -((weekday(date) + 6) % 7));
}

export function monthStart(date: LocalDate): LocalDate {
  return `${date.slice(0, 8)}01`;
}

/** First day of the following month. */
export function nextMonthStart(date: LocalDate): LocalDate {
  const [y, m] = date.split("-").map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
}

export function previousMonthStart(date: LocalDate): LocalDate {
  const [y, m] = date.split("-").map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12-01` : `${y}-${String(m - 1).padStart(2, "0")}-01`;
}

/** From this hour a missed agenda is a shorter catch-up (spec §8). */
export const AGENDA_CATCH_UP_HOUR = 12;
/** From this hour a missed agenda is skipped and the date counted as covered. */
export const AGENDA_SKIP_HOUR = 20;

/** The local date the agenda belongs to, if it is due (its hour or later, local time). */
export function agendaDueDate(
  now: number,
  timeZone: string,
  agendaHour: number = AGENDA_HOUR,
): LocalDate | null {
  return wallPartsAt(now, timeZone).hour >= agendaHour ? localDateAt(now, timeZone) : null;
}

/**
 * When the next agenda becomes due: today at 8am if today's isn't covered yet
 * (now, if that has passed), otherwise tomorrow at 8am. A skipped 8am (DST)
 * falls back to the following hour.
 */
export function nextAgendaAt(
  now: number,
  timeZone: string,
  todayCovered: boolean,
  agendaHour: number = AGENDA_HOUR,
): number {
  const today = localDateAt(now, timeZone);
  const date = todayCovered ? addDays(today, 1) : today;
  const hour = (h: number) => `${String(h).padStart(2, "0")}:00`;
  for (const time of [hour(agendaHour), hour(agendaHour + 1)]) {
    const at = zonedInstant(date, time, timeZone);
    if (at.ok) return todayCovered ? at.instant : Math.max(now, at.instant);
  }
  return now + 60 * 60_000;
}

/**
 * The evening preview due now, if any: from its hour until midnight, for the
 * local date (it previews the next day). Not sent late after midnight.
 */
export function eveningDueDate(
  now: number,
  timeZone: string,
  eveningHour: number | null,
): LocalDate | null {
  if (eveningHour === null) return null;
  return wallPartsAt(now, timeZone).hour >= eveningHour ? localDateAt(now, timeZone) : null;
}

/** When the next evening preview is due: today if not yet sent, else tomorrow. */
export function nextEveningAt(
  now: number,
  timeZone: string,
  sentToday: boolean,
  eveningHour: number,
): number | null {
  const today = localDateAt(now, timeZone);
  const date = sentToday ? addDays(today, 1) : today;
  const at = zonedInstant(date, `${String(eveningHour).padStart(2, "0")}:00`, timeZone);
  if (!at.ok) return null;
  return sentToday ? at.instant : Math.max(now, at.instant);
}

/** A nightly window by local hour; it may cross midnight (22 → 7). */
export interface QuietHours {
  start: number;
  end: number;
}

/**
 * The quiet-hours window containing `now`, or else the one that ended most
 * recently, as instants. Null when the zone skips the boundary hour (DST).
 */
export function quietWindow(
  now: number,
  timeZone: string,
  quiet: QuietHours,
): { from: number; to: number; active: boolean } | null {
  const today = localDateAt(now, timeZone);
  const at = (date: LocalDate, hour: number) => {
    const r = zonedInstant(date, `${String(hour).padStart(2, "0")}:00`, timeZone);
    return r.ok ? r.instant : null;
  };
  const crosses = quiet.start > quiet.end;
  // Candidate windows that start yesterday, today, or (for completeness) tomorrow.
  for (const offset of [0, -1, -2]) {
    const startDate = addDays(today, offset);
    const from = at(startDate, quiet.start);
    const to = at(crosses ? addDays(startDate, 1) : startDate, quiet.end);
    if (from === null || to === null) return null;
    if (from <= now) return { from, to, active: now < to };
  }
  return null;
}

/**
 * Which agenda is due for an unsent local date: the full one in the morning,
 * a catch-up of the rest of the day from noon, none (date covered) from 8pm.
 */
export function agendaKind(
  now: number,
  timeZone: string,
  agendaHour: number = AGENDA_HOUR,
): { date: LocalDate; kind: "full" | "catch_up" | "skip" } | null {
  const hour = wallPartsAt(now, timeZone).hour;
  if (hour < agendaHour) return null;
  const kind =
    hour >= AGENDA_SKIP_HOUR ? "skip" : hour >= AGENDA_CATCH_UP_HOUR ? "catch_up" : "full";
  return { date: localDateAt(now, timeZone), kind };
}

/**
 * Reminder keys identify one logical reminder. They include the target's time
 * and the rule, so moving an event or changing its reminders schedules a new
 * reminder instead of suppressing it. A lead time is written as bare minutes,
 * as it was before items had several reminders.
 */
export const reminderKeys = {
  /** `when` is the start instant (or an all-day date); `rule` the minutes or a rule code. */
  event: (calendarId: string, eventId: string, when: number | string, rule: number | string) =>
    `event:${calendarId}/${eventId}:${when}:${rule}`,
  /** `when` is the exact deadline (or a date-only deadline's date). */
  taskDue: (taskId: string, when: number | string, rule: number | string) =>
    `task:${taskId}:${when}:${rule}`,
  snooze: (taskId: string, until: number) => `snooze:${taskId}:${until}`,
};
