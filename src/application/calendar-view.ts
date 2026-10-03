import type { CalendarPort, CalendarSyncSource } from "../calendar/port";
import type { EventFields } from "../domain/calendar-event";
import { isDueOn, isOverdue } from "../domain/schedule";
import { addDays, type LocalDate, localDateAt, zonedInstant } from "../domain/time";
import { listCachedEvents } from "../storage/events";
import { listStoredCalendars, type StoredCalendar } from "../storage/google";
import { isSnoozed, listOpenTasks, type TaskRecord } from "../storage/tasks";
import type { UserRecord } from "../storage/users";
import { formatDayLabel, formatEventRange, formatTime } from "../telegram/format";
import { sortByDeadline } from "./task-flow";

/**
 * Reading what is on a user's calendar for a period, and rendering it. Events
 * are read live from Google (which expands recurring events) and fall back to
 * the synced copy, labelled as such, when Google cannot be reached.
 */

export interface RangeEvent {
  calendarId: string;
  eventId: string;
  fields: EventFields;
}

export interface RangeEvents {
  events: RangeEvent[];
  /** False when Google was unreachable and the synced copy was used instead. */
  live: boolean;
}

export type SourceFor = (
  userId: string,
) => Promise<(CalendarSyncSource & Pick<CalendarPort, "getEvent">) | null>;

export interface ViewDeps {
  db: D1Database;
  sourceFor: SourceFor;
}

/** Calendars whose events appear in views: selected, listed, and not the task calendar. */
export function viewCalendars(
  user: UserRecord,
  calendars: StoredCalendar[],
  only?: string,
): StoredCalendar[] {
  return calendars.filter(
    (c) =>
      c.selected &&
      c.listed &&
      c.calendarId !== user.taskCalendarId &&
      c.accessRole !== "freeBusyReader" &&
      (!only || c.calendarId === only),
  );
}

function localMidnight(date: LocalDate, timeZone: string): number {
  const start = zonedInstant(date, "00:00", timeZone);
  // Midnight is skipped by DST in a few zones; 01:00 is then the day's start.
  return start.ok
    ? start.instant
    : (zonedInstant(date, "01:00", timeZone) as { instant: number }).instant;
}

/** Events overlapping [from, to) local dates, excluding declined invitations. */
export async function eventsBetween(
  deps: ViewDeps,
  user: UserRecord,
  from: LocalDate,
  to: LocalDate,
  onlyCalendar?: string,
): Promise<RangeEvents> {
  const calendars = viewCalendars(user, await listStoredCalendars(deps.db, user.id), onlyCalendar);
  const start = localMidnight(from, user.timezone);
  const end = localMidnight(to, user.timezone);
  const source = await deps.sourceFor(user.id);
  if (source) {
    const events: RangeEvent[] = [];
    let complete = true;
    for (const calendar of calendars) {
      const listed = await source.listWindow(calendar.calendarId, start, end);
      if (!listed.ok) {
        complete = false;
        break;
      }
      for (const item of listed.value) {
        if (item.status === "cancelled" || item.declined || !item.fields) continue;
        events.push({ calendarId: calendar.calendarId, eventId: item.id, fields: item.fields });
      }
    }
    if (complete) return { events: sortEvents(events, user.timezone), live: true };
  }
  const cached = await listCachedEvents(
    deps.db,
    user.id,
    { from: start, to: end, fromDate: from, toDate: to },
    calendars.map((c) => c.calendarId),
    500,
  );
  return {
    events: sortEvents(
      cached
        .filter((e) => !e.declined)
        .map((e) => ({ calendarId: e.calendarId, eventId: e.eventId, fields: e.fields })),
      user.timezone,
    ),
    live: false,
  };
}

function startKey(fields: EventFields, timeZone: string): number {
  const { start } = fields;
  return "dateTime" in start ? Date.parse(start.dateTime) : localMidnight(start.date, timeZone) - 1;
}

function sortEvents(events: RangeEvent[], timeZone: string): RangeEvent[] {
  return events.sort((a, b) => startKey(a.fields, timeZone) - startKey(b.fields, timeZone));
}

/** Whether an event occupies any part of a local date. */
export function eventOnDate(fields: EventFields, date: LocalDate, timeZone: string): boolean {
  const { start, end } = fields;
  if ("date" in start && "date" in end) return start.date <= date && end.date > date;
  if (!("dateTime" in start) || !("dateTime" in end)) return false;
  const dayStart = localMidnight(date, timeZone);
  const dayEnd = localMidnight(addDays(date, 1), timeZone);
  const s = Date.parse(start.dateTime);
  const e = Math.max(Date.parse(end.dateTime), s + 1); // zero-length events still count
  return s < dayEnd && e > dayStart;
}

// --- Tasks for a period ---------------------------------------------------------------

export interface DayTasks {
  due: TaskRecord[];
  overdue: TaskRecord[];
  openEnded: number;
}

/**
 * Tasks for a day's summary. Snoozed tasks stay out of automatic summaries
 * (agenda, overdue) until the snooze expires; on-demand views may still show them.
 */
export async function tasksForDay(
  db: D1Database,
  user: UserRecord,
  date: LocalDate,
  now: number,
  includeSnoozed: boolean,
): Promise<DayTasks> {
  const open = sortByDeadline(await listOpenTasks(db, user.id, null), user.timezone);
  const shown = includeSnoozed ? open : open.filter((t) => !isSnoozed(t, now));
  const today = localDateAt(now, user.timezone);
  return {
    due: shown.filter((t) => isDueOn(t.deadline, date, user.timezone)),
    overdue:
      date === today
        ? shown.filter(
            (t) =>
              isOverdue(t.deadline, now, user.timezone) &&
              !isDueOn(t.deadline, date, user.timezone),
          )
        : [],
    openEnded: open.filter((t) => t.deadline.kind === "none").length,
  };
}

// --- Rendering ---------------------------------------------------------------------

/** Keeps each section well inside Telegram's 4096-character message limit. */
const MAX_LINES = 20;

function capped(lines: string[]): string[] {
  if (lines.length <= MAX_LINES) return lines;
  return [...lines.slice(0, MAX_LINES), `…and ${lines.length - MAX_LINES} more`];
}

/** "7–8pm Dinner", "All day · Holiday", with the calendar name when several are shown. */
export function eventLine(
  event: RangeEvent,
  date: LocalDate,
  timeZone: string,
  calendarName: string | null,
): string {
  const where = calendarName ? ` (${calendarName})` : "";
  const { start } = event.fields;
  if ("date" in start) return `• All day · ${event.fields.summary}${where}`;
  const range = formatEventRange(event.fields, timeZone);
  // Drop the date prefix when the event is within this day.
  const prefix = `${formatDayLabel(date)} `;
  const time = range.includes(prefix) ? range.slice(range.indexOf(", ") + 2) : range;
  return `• ${time} ${event.fields.summary}${where}`;
}

export function taskLine(task: TaskRecord, timeZone: string, withDate: boolean): string {
  const name = `[${task.listName}] ${task.title}`;
  if (task.deadline.kind === "datetime") {
    const time = formatTime(task.deadline.at, timeZone);
    const day = withDate ? `${formatDayLabel(localDateAt(task.deadline.at, timeZone))}, ` : "";
    return `• ${name} · ${withDate ? "due " : ""}${day}${time}`;
  }
  if (task.deadline.kind === "date" && withDate)
    return `• ${name} · due ${formatDayLabel(task.deadline.date)}`;
  return `• ${name}`;
}

/**
 * Overdue lines, with several overdue occurrences of one recurring task grouped
 * into a single line (spec §6). Occurrence-specific actions remain in /overdue.
 */
export function overdueLines(tasks: TaskRecord[], timeZone: string): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const task of tasks) {
    if (!task.seriesId) {
      lines.push(taskLine(task, timeZone, true));
      continue;
    }
    if (seen.has(task.seriesId)) continue;
    seen.add(task.seriesId);
    const group = tasks.filter((t) => t.seriesId === task.seriesId);
    if (group.length === 1) {
      lines.push(taskLine(task, timeZone, true));
      continue;
    }
    const dates = group.map((t) =>
      formatDayLabel(t.deadline.kind === "date" ? t.deadline.date : (t.occurrenceDate ?? "")),
    );
    lines.push(
      `• [${task.listName}] ${task.title} · ${group.length} overdue (due ${dates.join(", ")})`,
    );
  }
  return lines;
}

function calendarNames(calendars: StoredCalendar[]): (id: string) => string | null {
  if (calendars.length <= 1) return () => null;
  return (id) => calendars.find((c) => c.calendarId === id)?.summary ?? null;
}

export async function renderDay(
  deps: ViewDeps,
  user: UserRecord,
  date: LocalDate,
  now: number,
  options: { heading: string; includeSnoozed: boolean },
): Promise<{ text: string; live: boolean }> {
  const calendars = viewCalendars(user, await listStoredCalendars(deps.db, user.id));
  const name = calendarNames(calendars);
  const { events, live } = await eventsBetween(deps, user, date, addDays(date, 1));
  const tasks = await tasksForDay(deps.db, user, date, now, options.includeSnoozed);

  const lines = [options.heading, `${formatDayLabel(date)} ${date.slice(0, 4)}`, ""];
  const todays = events.filter((e) => eventOnDate(e.fields, date, user.timezone));
  if (todays.length === 0) {
    lines.push(
      date === localDateAt(now, user.timezone) ? "Your calendar is clear today." : "No events.",
    );
  } else {
    lines.push(
      "Events",
      ...capped(todays.map((e) => eventLine(e, date, user.timezone, name(e.calendarId)))),
    );
  }
  if (tasks.due.length > 0) {
    lines.push("", "Due today", ...capped(tasks.due.map((t) => taskLine(t, user.timezone, false))));
  }
  if (tasks.overdue.length > 0) {
    lines.push(
      "",
      tasks.overdue.length === 1
        ? "1 task is overdue"
        : `${tasks.overdue.length} tasks are overdue`,
      ...capped(overdueLines(tasks.overdue, user.timezone)),
    );
  }
  if (tasks.openEnded > 0) {
    lines.push(
      "",
      tasks.openEnded === 1
        ? "1 task without a deadline"
        : `${tasks.openEnded} tasks without deadlines`,
    );
  }
  if (!live) lines.push("", "Google Calendar couldn't be reached; events are from the last sync.");
  return { text: lines.join("\n"), live };
}

/** Days of [from, to) with their events and due tasks, compactly. */
export async function renderPeriod(
  deps: ViewDeps,
  user: UserRecord,
  from: LocalDate,
  to: LocalDate,
  heading: string,
  options: { compact: boolean; onlyCalendar?: string },
): Promise<string> {
  const calendars = viewCalendars(
    user,
    await listStoredCalendars(deps.db, user.id),
    options.onlyCalendar,
  );
  const name = options.onlyCalendar ? () => null : calendarNames(calendars);
  const { events, live } = await eventsBetween(deps, user, from, to, options.onlyCalendar);
  const tasks = options.onlyCalendar ? [] : await listOpenTasks(deps.db, user.id, null);

  const lines = [heading];
  let any = false;
  for (let date = from; date < to; date = addDays(date, 1)) {
    const day = events.filter((e) => eventOnDate(e.fields, date, user.timezone));
    const due = sortByDeadline(
      tasks.filter((t) => isDueOn(t.deadline, date, user.timezone)),
      user.timezone,
    );
    if (day.length === 0 && due.length === 0) continue;
    any = true;
    if (options.compact) {
      const titles = day.map((e) => compactEvent(e, user.timezone));
      const shown = titles.slice(0, 3);
      const more = titles.length > 3 ? ` +${titles.length - 3} more` : "";
      const taskNote = due.length ? `${shown.length ? "; " : ""}${due.length} due` : "";
      lines.push(`${formatDayLabel(date)} · ${shown.join("; ")}${more}${taskNote}`);
    } else {
      lines.push("", formatDayLabel(date));
      lines.push(...day.map((e) => eventLine(e, date, user.timezone, name(e.calendarId))));
      lines.push(...due.map((t) => `${taskLine(t, user.timezone, false)} (due)`));
    }
  }
  if (!any) lines.push("", "Nothing scheduled.");
  if (!live) lines.push("", "Google Calendar couldn't be reached; events are from the last sync.");
  const text = lines.join("\n");
  return text.length > 4000 ? `${text.slice(0, 3990)}\n…` : text;
}

function compactEvent(event: RangeEvent, timeZone: string): string {
  const { start } = event.fields;
  if ("date" in start) return event.fields.summary;
  return `${formatTime(Date.parse(start.dateTime), timeZone)} ${event.fields.summary}`;
}
