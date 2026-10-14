import {
  eventOnDate,
  eventsBetween,
  type RangeEvent,
  type SourceFor,
  tasksForDay,
  viewCalendars,
} from "../application/calendar-view";
import { recurrenceOf } from "../application/series";
import { dueLabel, RECENT_DAYS, sortByDeadline } from "../application/task-flow";
import { PROJECT_TASK } from "../application/task-projection";
import { describeRecurrence } from "../domain/recurrence";
import { isDueOn, isOverdue, weekStart } from "../domain/schedule";
import { addDays, type LocalDate, localDateAt, wallPartsAt } from "../domain/time";
import { syncSummary } from "../jobs/calendar-sync";
import { findConnection, listStoredCalendars } from "../storage/google";
import { reminderOverrides } from "../storage/reminders";
import { findSeries } from "../storage/series";
import { upcomingSessions } from "../storage/sessions";
import {
  findTask,
  isSnoozed,
  listOpenTasks,
  listRecentTasks,
  listTaskLists,
  type TaskRecord,
} from "../storage/tasks";
import type { UserRecord } from "../storage/users";
import { formatDayLabel, formatEventRange, formatShortStart, formatTime } from "../telegram/format";

/**
 * The Mini App's read model (ADR 0005): plain JSON built from the same queries
 * and helpers as the chat views. Every function takes the authenticated user
 * and reads only that user's rows.
 */

export interface ReadDeps {
  db: D1Database;
  sourceFor: SourceFor;
}

export interface AppTask {
  id: string;
  version: number;
  title: string;
  list: { id: string; name: string };
  deadline: {
    kind: "none" | "date" | "datetime";
    date: LocalDate | null;
    /** Instant for exact deadlines (ms). */
    at: number | null;
    /** The exact deadline's local time (HH:MM) in the user's zone. */
    time: string | null;
    label: string;
  };
  status: TaskRecord["status"];
  overdue: boolean;
  snoozedUntil: number | null;
  snoozeLabel: string | null;
  /** How long past its deadline an open task is ("3 days overdue"); null when not overdue. */
  overdueLabel: string | null;
  /** The deadline marker is still being written to Google Calendar. */
  pending: boolean;
  seriesId: string | null;
}

export interface AppEvent {
  calendarId: string;
  eventId: string;
  title: string;
  allDay: boolean;
  /** "9–10am", "All day", or a range across days. */
  timeLabel: string;
  calendarName: string | null;
  /** Opens the event (or its day) in Google Calendar. */
  link: string;
  startsAt: number | null;
}

/** Task IDs with a deadline marker write still queued or retrying. */
export async function pendingTaskIds(db: D1Database, userId: string): Promise<Set<string>> {
  const { results } = await db
    .prepare(
      `SELECT DISTINCT json_extract(intent, '$.taskId') AS task_id FROM operations
       WHERE user_id = ? AND kind = ? AND status IN ('ready', 'retry_wait', 'applying')`,
    )
    .bind(userId, PROJECT_TASK)
    .all<{ task_id: string | null }>();
  return new Set(results.flatMap((r) => (r.task_id ? [r.task_id] : [])));
}

export function toAppTask(
  task: TaskRecord,
  user: UserRecord,
  now: number,
  pending: Set<string>,
): AppTask {
  const d = task.deadline;
  const snoozed = isSnoozed(task, now) && task.snoozedUntil !== null;
  const overdue = task.status === "open" && isOverdue(d, now, user.timezone);
  return {
    id: task.id,
    version: task.version,
    title: task.title,
    list: { id: task.listId, name: task.listName },
    deadline: {
      kind: d.kind,
      date:
        d.kind === "date"
          ? d.date
          : d.kind === "datetime"
            ? localDateAt(d.at, user.timezone)
            : null,
      at: d.kind === "datetime" ? d.at : null,
      time:
        d.kind === "datetime"
          ? (() => {
              const w = wallPartsAt(d.at, user.timezone);
              return `${String(w.hour).padStart(2, "0")}:${String(w.minute).padStart(2, "0")}`;
            })()
          : null,
      label: dueLabel(d, user.timezone),
    },
    status: task.status,
    overdue,
    snoozedUntil: snoozed ? task.snoozedUntil : null,
    snoozeLabel:
      snoozed && task.snoozedUntil !== null
        ? `Snoozed until ${formatDayLabel(localDateAt(task.snoozedUntil, user.timezone))} ${formatTime(task.snoozedUntil, user.timezone)}`
        : null,
    overdueLabel: overdue ? overdueLabel(d, now, user.timezone) : null,
    pending: pending.has(task.id),
    seriesId: task.seriesId,
  };
}

/** Whole local days between two dates (b - a). */
function daysFrom(a: LocalDate, b: LocalDate): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** Age of a missed deadline in the user's days: "Overdue since 5pm", "1 day overdue". */
function overdueLabel(d: TaskRecord["deadline"], now: number, timeZone: string): string {
  if (d.kind === "none") return "Overdue";
  const due = d.kind === "date" ? d.date : localDateAt(d.at, timeZone);
  const days = daysFrom(due, localDateAt(now, timeZone));
  if (days <= 0)
    return d.kind === "datetime" ? `Overdue since ${formatTime(d.at, timeZone)}` : "Overdue";
  return days === 1 ? "1 day overdue" : `${days} days overdue`;
}

/** "Saturday 10 Oct": the Home heading, without the year. */
export function longDayLabel(date: LocalDate): string {
  const weekdayName = new Intl.DateTimeFormat("en-GB", { weekday: "long", timeZone: "UTC" }).format(
    new Date(`${date}T00:00:00Z`),
  );
  // Same day and month as everywhere else ("25 Sep"), with the weekday in full.
  return `${weekdayName} ${formatDayLabel(date).split(" ").slice(1).join(" ")}`;
}

function dayLink(date: LocalDate): string {
  return `https://calendar.google.com/calendar/r/day/${date.replaceAll("-", "/")}`;
}

function toAppEvent(
  e: RangeEvent,
  date: LocalDate,
  user: UserRecord,
  names: Map<string, string>,
  showCalendar: boolean,
): AppEvent {
  const allDay = "date" in e.fields.start;
  const range = formatEventRange(e.fields, user.timezone);
  // Within one day, drop the date prefix ("Fri 9 Oct 2026, 7–8pm" → "7–8pm").
  const comma = range.indexOf(", ");
  const timeLabel = allDay
    ? "All day"
    : range.startsWith(formatDayLabel(date)) && comma !== -1
      ? range.slice(comma + 2)
      : range;
  return {
    calendarId: e.calendarId,
    eventId: e.eventId,
    title: e.fields.summary,
    allDay,
    timeLabel,
    calendarName: showCalendar ? (names.get(e.calendarId) ?? null) : null,
    link: e.htmlLink ?? dayLink(date),
    startsAt: "dateTime" in e.fields.start ? Date.parse(e.fields.start.dateTime) : null,
  };
}

async function calendarNames(deps: ReadDeps, user: UserRecord) {
  const calendars = viewCalendars(user, await listStoredCalendars(deps.db, user.id));
  return {
    names: new Map(calendars.map((c) => [c.calendarId, c.summary])),
    several: calendars.length > 1,
  };
}

/** The snooze shortcut ends at the agenda time, as in chat. */
export function tomorrowLabel(user: UserRecord): string {
  return `Tomorrow at ${formatTime(Date.UTC(2000, 0, 1, user.agendaHour), "UTC")}`;
}

// --- Today ---------------------------------------------------------------------

export async function todayView(deps: ReadDeps, user: UserRecord, now: number) {
  const date = localDateAt(now, user.timezone);
  const [{ events, live }, tasks, pending, cal] = await Promise.all([
    eventsBetween(deps, user, date, addDays(date, 1)),
    tasksForDay(deps.db, user, date, now, false),
    pendingTaskIds(deps.db, user.id),
    calendarNames(deps, user),
  ]);
  const todays = events
    .filter((e) => eventOnDate(e.fields, date, user.timezone))
    .map((e) => toAppEvent(e, date, user, cal.names, cal.several));
  return {
    date,
    label: `${formatDayLabel(date)} ${date.slice(0, 4)}`,
    live,
    allDay: todays.filter((e) => e.allDay),
    timed: todays.filter((e) => !e.allDay),
    overdue: tasks.overdue.map((t) => toAppTask(t, user, now, pending)),
    due: tasks.due.map((t) => toAppTask(t, user, now, pending)),
    openEnded: tasks.openEnded,
    tomorrowLabel: tomorrowLabel(user),
  };
}

// --- Home ----------------------------------------------------------------------

export async function homeView(deps: ReadDeps, user: UserRecord, now: number) {
  const today = await todayView(deps, user, now);
  const [lists, recent, open, connection, sync] = await Promise.all([
    listTaskLists(deps.db, user.id),
    listRecentTasks(deps.db, user.id, now - RECENT_DAYS * 86_400_000, 100),
    listOpenTasks(deps.db, user.id, null),
    findConnection(deps.db, user.id),
    syncSummary(deps.db, user.id),
  ]);
  const weekEnd = addDays(weekStart(today.date), 7);
  const dueThisWeek = open.filter(
    (t) =>
      t.deadline.kind !== "none" &&
      (() => {
        const d =
          t.deadline.kind === "date" ? t.deadline.date : localDateAt(t.deadline.at, user.timezone);
        return d >= today.date && d < weekEnd;
      })(),
  ).length;
  const next = nextUp(today, now, user);
  return {
    date: today.date,
    label: today.label,
    heading: longDayLabel(today.date),
    nextUp: next?.text ?? null,
    next,
    calendarClear: today.allDay.length + today.timed.length === 0,
    tiles: {
      today: { events: today.allDay.length + today.timed.length, tasks: today.due.length },
      overdue: today.overdue.length,
      week: dueThisWeek,
      noDeadline: today.openEnded,
    },
    lists: lists.map((l) => ({ id: l.id, name: l.name, open: l.openCount, inbox: l.isInbox })),
    recent: recent.length,
    sync: syncLine(connection?.status ?? null, sync, today.live, now),
    tomorrowLabel: tomorrowLabel(user),
    reconnect: connection?.status !== "active",
  };
}

function nextUp(
  today: Awaited<ReturnType<typeof todayView>>,
  now: number,
  user: UserRecord,
): NextUp | null {
  const event = today.timed.find((e) => (e.startsAt ?? 0) > now);
  if (event?.startsAt) {
    const minutes = Math.round((event.startsAt - now) / 60_000);
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    const when = minutes < 60 ? `in ${minutes} min` : `in ${hours} hr${rest ? ` ${rest} min` : ""}`;
    const time = formatTime(event.startsAt, user.timezone);
    return {
      kind: "event",
      time,
      title: event.title,
      when,
      link: event.link,
      text: `${time} ${event.title} · ${when}`,
    };
  }
  const task = today.due.find((t) => t.deadline.at !== null && t.deadline.at > now);
  if (task?.deadline.at) {
    const time = formatTime(task.deadline.at, user.timezone);
    return {
      kind: "task",
      time,
      title: task.title,
      when: "Due",
      taskId: task.id,
      text: `Due ${time}: ${task.title}`,
    };
  }
  return null;
}

/** The Home "Next up" line, in parts so the time can lead. */
export interface NextUp {
  kind: "event" | "task";
  time: string;
  title: string;
  when: string;
  link?: string;
  taskId?: string;
  text: string;
}

function syncLine(
  status: string | null,
  sync: Awaited<ReturnType<typeof syncSummary>>,
  live: boolean,
  now: number,
): string {
  if (status !== "active") return "Google Calendar needs reconnecting";
  if (!live) return "Showing saved copy: Google Calendar couldn't be reached";
  if (sync.lastSuccessAt === null) return "First sync in progress";
  const minutes = Math.floor((now - sync.lastSuccessAt) / 60_000);
  return minutes < 1 ? "Synced just now" : `Synced ${minutes} min ago`;
}

// --- Week ----------------------------------------------------------------------

export async function weekView(
  deps: ReadDeps,
  user: UserRecord,
  now: number,
  start: LocalDate | null,
) {
  const today = localDateAt(now, user.timezone);
  const from = weekStart(start ?? today);
  const to = addDays(from, 7);
  const [{ events, live }, open, pending, cal] = await Promise.all([
    eventsBetween(deps, user, from, to),
    listOpenTasks(deps.db, user.id, null),
    pendingTaskIds(deps.db, user.id),
    calendarNames(deps, user),
  ]);
  const sorted = sortByDeadline(open, user.timezone);
  const days = [];
  for (let date = from; date < to; date = addDays(date, 1)) {
    days.push({
      date,
      label: formatDayLabel(date),
      today: date === today,
      events: events
        .filter((e) => eventOnDate(e.fields, date, user.timezone))
        .map((e) => toAppEvent(e, date, user, cal.names, cal.several)),
      tasks: sorted
        .filter((t) => isDueOn(t.deadline, date, user.timezone))
        .map((t) => toAppTask(t, user, now, pending)),
    });
  }
  return {
    start: from,
    label: `Week of ${formatDayLabel(from)} ${from.slice(0, 4)}`,
    previous: addDays(from, -7),
    next: to,
    live,
    days,
  };
}

// --- Task sets, detail, recent -----------------------------------------------------

export type TaskSet =
  | { view: "overdue" }
  | { view: "no_deadline" }
  | { view: "list"; listId: string };

export async function taskSetView(deps: ReadDeps, user: UserRecord, now: number, set: TaskSet) {
  const lists = await listTaskLists(deps.db, user.id);
  const list = set.view === "list" ? lists.find((l) => l.id === set.listId) : undefined;
  if (set.view === "list" && !list) return null;
  const [open, pending] = await Promise.all([
    listOpenTasks(deps.db, user.id, list?.id ?? null),
    pendingTaskIds(deps.db, user.id),
  ]);
  const chosen =
    set.view === "overdue"
      ? open.filter((t) => isOverdue(t.deadline, now, user.timezone) && !isSnoozed(t, now))
      : set.view === "no_deadline"
        ? open.filter((t) => t.deadline.kind === "none")
        : open;
  const title =
    set.view === "overdue" ? "Overdue" : set.view === "no_deadline" ? "No deadline" : list?.name;
  return {
    title,
    showList: set.view !== "list",
    listId: list?.id ?? null,
    tomorrowLabel: tomorrowLabel(user),
    tasks: sortByDeadline(chosen, user.timezone).map((t) => toAppTask(t, user, now, pending)),
    lists: lists.map((l) => ({ id: l.id, name: l.name })),
  };
}

export async function taskDetail(deps: ReadDeps, user: UserRecord, now: number, taskId: string) {
  const task = await findTask(deps.db, user.id, taskId);
  if (!task) return null;
  const [pending, series, overrides, sessions, lists] = await Promise.all([
    pendingTaskIds(deps.db, user.id),
    task.seriesId ? findSeries(deps.db, user.id, task.seriesId) : Promise.resolve(null),
    reminderOverrides(deps.db, user.id, "task"),
    upcomingSessions(deps.db, user.id, task.id, now, 3),
    listTaskLists(deps.db, user.id),
  ]);
  const override = overrides.get(task.id);
  const history = await deps.db
    .prepare(
      "SELECT created_at, completed_at, cancelled_at FROM tasks WHERE id = ? AND user_id = ?",
    )
    .bind(task.id, user.id)
    .first<{ created_at: number; completed_at: number | null; cancelled_at: number | null }>();
  const stamp = (label: string, at: number | null | undefined) =>
    at
      ? [
          `${label} ${formatDayLabel(localDateAt(at, user.timezone))} ${formatTime(at, user.timezone)}`,
        ]
      : [];
  return {
    task: toAppTask(task, user, now, pending),
    reminder:
      task.deadline.kind !== "datetime"
        ? null
        : override === null
          ? "No reminder"
          : `${override ?? user.reminderMinutes} minutes before`,
    repeat: series
      ? {
          seriesId: series.id,
          version: series.version,
          label: describeRecurrence(recurrenceOf(series)),
          active: series.status === "active",
        }
      : null,
    workTime: sessions.map((s) => formatShortStart(s.fields, user.timezone)),
    tomorrowLabel: tomorrowLabel(user),
    history: [
      ...stamp("Added", history?.created_at),
      ...stamp("Completed", history?.completed_at),
      ...stamp("Cancelled", history?.cancelled_at),
    ],
    lists: lists.map((l) => ({ id: l.id, name: l.name })),
  };
}

export async function recentView(deps: ReadDeps, user: UserRecord, now: number) {
  const [tasks, pending] = await Promise.all([
    listRecentTasks(deps.db, user.id, now - RECENT_DAYS * 86_400_000, 100),
    pendingTaskIds(deps.db, user.id),
  ]);
  return {
    days: RECENT_DAYS,
    tasks: tasks.map((t) => ({
      ...toAppTask(t, user, now, pending),
      closedLabel: `${t.status === "completed" ? "Done" : "Cancelled"} ${formatDayLabel(localDateAt(t.closedAt, user.timezone))}`,
    })),
  };
}
