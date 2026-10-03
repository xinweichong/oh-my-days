import type { Deadline } from "./tasks";
import { addDays, type LocalDate, localDateAt, wallPartsAt, weekday } from "./time";

/** Spec §5: one hour before timed events. */
export const DEFAULT_EVENT_REMINDER_MINUTES = 60;
/** Spec §6: exact-time deadlines are reminded one hour before. */
export const DEFAULT_TASK_REMINDER_MINUTES = 60;
/** Spec §7: the daily agenda at 8am in the user's timezone. */
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

/** The local date the agenda belongs to, if it is due (8am or later local time). */
export function agendaDueDate(now: number, timeZone: string): LocalDate | null {
  return wallPartsAt(now, timeZone).hour >= AGENDA_HOUR ? localDateAt(now, timeZone) : null;
}

/**
 * Reminder keys identify one logical reminder. They include the target's time
 * and the offset, so moving an event or changing its reminder schedules a new
 * reminder instead of suppressing it.
 */
export const reminderKeys = {
  event: (calendarId: string, eventId: string, startsAt: number, minutes: number) =>
    `event:${calendarId}/${eventId}:${startsAt}:${minutes}`,
  taskDue: (taskId: string, dueAt: number, minutes: number) => `task:${taskId}:${dueAt}:${minutes}`,
  snooze: (taskId: string, until: number) => `snooze:${taskId}:${until}`,
};
