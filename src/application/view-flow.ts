import { parseLocalDate, parseWallTime } from "../domain/parse-input";
import {
  DEFAULT_EVENT_REMINDER_MINUTES,
  DEFAULT_TASK_REMINDER_MINUTES,
  isOverdue,
  monthStart,
  nextMonthStart,
  previousMonthStart,
  weekStart,
} from "../domain/schedule";
import { addDays, type LocalDate, localDateAt, zonedInstant } from "../domain/time";
import { findCachedEvent } from "../storage/events";
import { listStoredCalendars } from "../storage/google";
import {
  clearPendingInputStatement,
  type PendingInput,
  setPendingInputStatement,
  type UiAction,
} from "../storage/interactions";
import { horizonEvents, reminderOverrides, setOverrideStatement } from "../storage/reminders";
import { findTask, listOpenTasks, setSnoozeStatement } from "../storage/tasks";
import type { UserRecord } from "../storage/users";
import type { InlineKeyboardButton } from "../telegram/api";
import { formatDayLabel, formatTime } from "../telegram/format";
import type { InboundCallback, InboundMessage } from "../telegram/update";
import { renderDay, renderPeriod, type SourceFor, viewCalendars } from "./calendar-view";
import { ActionButtons, combine, message, type Reaction } from "./reactions";
import { PENDING_INPUT_TTL_MS, type SetupDeps } from "./setup";
import { dueLabel, sortByDeadline } from "./task-flow";
import { answer, keyboardMessage, removeButtons } from "./ui";

/**
 * Deterministic views (no AI) and reminder controls: /daily, /weekly,
 * /monthly, /calendars, /overdue, /reminders, Snooze, and per-item reminder
 * overrides. Weekly and monthly views use actual calendar periods.
 */

export interface ViewFlowDeps extends SetupDeps {
  sourceFor: SourceFor;
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function today(deps: ViewFlowDeps, user: UserRecord): LocalDate {
  return localDateAt(deps.clock.now(), user.timezone);
}

function blocked(user: UserRecord): Reaction | null {
  return user.setupStep === "done"
    ? null
    : message(user.privateChatId, "Finish setup first: send /start to continue.");
}

// --- Commands ---------------------------------------------------------------------

export async function dailyView(deps: ViewFlowDeps, user: UserRecord): Promise<Reaction> {
  const stop = blocked(user);
  if (stop) return stop;
  const { text } = await renderDay(deps, user, today(deps, user), deps.clock.now(), {
    heading: "Today",
    includeSnoozed: false,
  });
  const buttons = new ActionButtons(deps.ids, user.id, deps.clock.now());
  return {
    replies: [
      keyboardMessage(
        user,
        text,
        {
          inline_keyboard: [
            [
              buttons.button("View tasks", "task_list", { listId: null, page: 0 }),
              buttons.button("View week", "view_week", {}),
            ],
          ],
        },
        null,
      ),
    ],
    statements: (db, guard) => buttons.statements(db, guard),
  };
}

export async function weekView(
  deps: ViewFlowDeps,
  user: UserRecord,
  start: LocalDate | null,
  calendarId: string | null,
  editMessageId: number | null,
): Promise<Reaction> {
  const stop = blocked(user);
  if (stop) return stop;
  const from = start ?? weekStart(today(deps, user));
  const to = addDays(from, 7);
  const calendars = await listStoredCalendars(deps.db, user.id);
  const only = calendarId ? calendars.find((c) => c.calendarId === calendarId) : undefined;
  const heading = `Week of ${formatDayLabel(from)} ${from.slice(0, 4)}${only ? ` · ${only.summary}` : ""}`;
  const text = await renderPeriod(deps, user, from, to, heading, {
    compact: false,
    ...(only ? { onlyCalendar: only.calendarId } : {}),
  });
  const buttons = new ActionButtons(deps.ids, user.id, deps.clock.now());
  const nav = (label: string, date: LocalDate) =>
    buttons.button(label, "view_week", { start: date, calendarId: only?.calendarId ?? null });
  const row = [nav("‹ Previous", addDays(from, -7))];
  if (from !== weekStart(today(deps, user)))
    row.push(nav("This week", weekStart(today(deps, user))));
  row.push(nav("Next ›", to));
  return {
    replies: [keyboardMessage(user, text, { inline_keyboard: [row] }, editMessageId)],
    statements: (db, guard) => buttons.statements(db, guard),
  };
}

export async function monthView(
  deps: ViewFlowDeps,
  user: UserRecord,
  start: LocalDate | null,
  editMessageId: number | null,
): Promise<Reaction> {
  const stop = blocked(user);
  if (stop) return stop;
  const from = start ?? monthStart(today(deps, user));
  const to = nextMonthStart(from);
  const heading = `${MONTHS[Number(from.slice(5, 7)) - 1]} ${from.slice(0, 4)}`;
  const text = await renderPeriod(deps, user, from, to, heading, { compact: true });
  const buttons = new ActionButtons(deps.ids, user.id, deps.clock.now());
  const nav = (label: string, date: LocalDate) =>
    buttons.button(label, "view_month", { start: date });
  const row = [nav("‹ Previous", previousMonthStart(from))];
  if (from !== monthStart(today(deps, user)))
    row.push(nav("This month", monthStart(today(deps, user))));
  row.push(nav("Next ›", to));
  return {
    replies: [keyboardMessage(user, text, { inline_keyboard: [row] }, editMessageId)],
    statements: (db, guard) => buttons.statements(db, guard),
  };
}

export async function calendarsView(deps: ViewFlowDeps, user: UserRecord): Promise<Reaction> {
  const stop = blocked(user);
  if (stop) return stop;
  const calendars = viewCalendars(user, await listStoredCalendars(deps.db, user.id));
  const buttons = new ActionButtons(deps.ids, user.id, deps.clock.now());
  const rows = calendars.map((c) => [
    buttons.button(c.summary, "view_week", { calendarId: c.calendarId }),
  ]);
  rows.push([buttons.button("Change selected calendars", "open_calendars", {})]);
  return {
    replies: [
      keyboardMessage(user, "Choose a calendar to see its week.", { inline_keyboard: rows }, null),
    ],
    statements: (db, guard) => buttons.statements(db, guard),
  };
}

export async function overdueView(deps: ViewFlowDeps, user: UserRecord): Promise<Reaction> {
  const stop = blocked(user);
  if (stop) return stop;
  const now = deps.clock.now();
  const overdue = sortByDeadline(await listOpenTasks(deps.db, user.id, null), user.timezone).filter(
    (t) => isOverdue(t.deadline, now, user.timezone),
  );
  if (overdue.length === 0) return message(user.privateChatId, "Nothing is overdue.");
  const buttons = new ActionButtons(deps.ids, user.id, now);
  const rows = overdue.slice(0, 20).map((t) => {
    const snoozed = t.snoozedUntil !== null && t.snoozedUntil > now ? " (snoozed)" : "";
    return [
      buttons.button(
        `[${t.listName}] ${t.title} · ${dueLabel(t.deadline, user.timezone).replace(/^Due /, "")}${snoozed}`.slice(
          0,
          64,
        ),
        "task_pick",
        { taskId: t.id },
      ),
    ];
  });
  const count =
    overdue.length === 1 ? "1 task is overdue." : `${overdue.length} tasks are overdue.`;
  return {
    replies: [keyboardMessage(user, count, { inline_keyboard: rows }, null)],
    statements: (db, guard) => buttons.statements(db, guard),
  };
}

function minutesText(minutes: number | null): string {
  if (minutes === null) return "no reminder";
  if (minutes === 0) return "at the time";
  if (minutes % 1440 === 0)
    return minutes === 1440 ? "1 day before" : `${minutes / 1440} days before`;
  if (minutes % 60 === 0) return minutes === 60 ? "1 hour before" : `${minutes / 60} hours before`;
  return `${minutes} minutes before`;
}

/** Upcoming reminders, snoozed tasks, and custom reminder settings. */
export async function remindersView(deps: ViewFlowDeps, user: UserRecord): Promise<Reaction> {
  const stop = blocked(user);
  if (stop) return stop;
  const now = deps.clock.now();
  const eventOverrides = await reminderOverrides(deps.db, user.id, "event");
  const taskOverrides = await reminderOverrides(deps.db, user.id, "task");
  const upcoming: { at: number; line: string }[] = [];

  for (const e of await horizonEvents(deps.db, user.id, now, now + 26 * 3_600_000)) {
    if (e.declined) continue;
    const key = `${e.calendarId}/${e.eventId}`;
    const minutes = eventOverrides.has(key)
      ? (eventOverrides.get(key) ?? null)
      : DEFAULT_EVENT_REMINDER_MINUTES;
    if (minutes === null) continue;
    const at = e.startsAt - minutes * 60_000;
    if (at < now) continue;
    upcoming.push({ at, line: `${e.summary} (${minutesText(minutes)})` });
  }
  const tasks = await listOpenTasks(deps.db, user.id, null);
  const snoozed: string[] = [];
  for (const t of tasks) {
    if (t.snoozedUntil !== null && t.snoozedUntil > now) {
      snoozed.push(`• [${t.listName}] ${t.title} · until ${when(t.snoozedUntil, user)}`);
      continue;
    }
    if (t.deadline.kind !== "datetime" || t.deadline.at <= now) continue;
    const minutes = taskOverrides.has(t.id)
      ? (taskOverrides.get(t.id) ?? null)
      : DEFAULT_TASK_REMINDER_MINUTES;
    if (minutes === null) continue;
    const at = t.deadline.at - minutes * 60_000;
    if (at >= now && at < now + 7 * 86_400_000) {
      upcoming.push({
        at,
        line: `[${t.listName}] ${t.title} (${minutesText(minutes)} the deadline)`,
      });
    }
  }

  const lines = ["Upcoming reminders"];
  const sorted = upcoming.sort((a, b) => a.at - b.at);
  lines.push(
    ...(sorted.length
      ? sorted.slice(0, 20).map((u) => `• ${when(u.at, user)} — ${u.line}`)
      : ["None in the next day."]),
  );
  lines.push("", "Date-only deadlines are in the 8am agenda.");
  if (snoozed.length) lines.push("", "Snoozed", ...snoozed);

  const custom: string[] = [];
  for (const [key, minutes] of eventOverrides) {
    const [calendarId = "", eventId = ""] = splitKey(key);
    const event = await findCachedEvent(deps.db, user.id, calendarId, eventId);
    const title =
      event?.fields.summary ?? (await horizonTitle(deps, user, calendarId, eventId)) ?? "An event";
    custom.push(`• ${title}: ${minutesText(minutes)}`);
  }
  for (const [taskId, minutes] of taskOverrides) {
    const task = await findTask(deps.db, user.id, taskId);
    if (task && task.status === "open")
      custom.push(`• [${task.listName}] ${task.title}: ${minutesText(minutes)}`);
  }
  if (custom.length) lines.push("", "Custom reminders", ...custom.slice(0, 20));
  return message(user.privateChatId, lines.join("\n"));
}

function splitKey(key: string): [string, string] {
  const index = key.lastIndexOf("/");
  return [key.slice(0, index), key.slice(index + 1)];
}

async function horizonTitle(
  deps: ViewFlowDeps,
  user: UserRecord,
  calendarId: string,
  eventId: string,
) {
  const events = await horizonEvents(deps.db, user.id, 0, Number.MAX_SAFE_INTEGER);
  return events.find((e) => e.calendarId === calendarId && e.eventId === eventId)?.summary ?? null;
}

function when(instant: number, user: UserRecord): string {
  return `${formatDayLabel(localDateAt(instant, user.timezone))} ${formatTime(instant, user.timezone)}`;
}

// --- Snooze and reminder settings -------------------------------------------------------

export function snoozeMenu(deps: SetupDeps, user: UserRecord, taskId: string): Reaction {
  const buttons = new ActionButtons(deps.ids, user.id, deps.clock.now());
  const now = deps.clock.now();
  const tomorrow8 = zonedInstant(
    addDays(localDateAt(now, user.timezone), 1),
    "08:00",
    user.timezone,
  );
  const row: InlineKeyboardButton[] = [
    buttons.button("In 1 hour", "snooze_set", { taskId, until: now + 3_600_000 }),
  ];
  if (tomorrow8.ok)
    row.push(buttons.button("Tomorrow at 8am", "snooze_set", { taskId, until: tomorrow8.instant }));
  return {
    replies: [
      keyboardMessage(
        user,
        "Snooze until when?",
        { inline_keyboard: [row, [buttons.button("Choose date/time", "snooze_pick", { taskId })]] },
        null,
      ),
    ],
    statements: (db, guard) => buttons.statements(db, guard),
  };
}

async function snooze(
  deps: SetupDeps,
  user: UserRecord,
  taskId: string,
  until: number,
): Promise<Reaction> {
  const task = await findTask(deps.db, user.id, taskId);
  if (task?.status !== "open") return message(user.privateChatId, "That task is no longer open.");
  const now = deps.clock.now();
  if (until <= now)
    return message(user.privateChatId, "That time has already passed. Choose a later time.");
  const deadline =
    task.deadline.kind === "none"
      ? "No deadline"
      : dueLabel(task.deadline, user.timezone).replace(/^Due /, "");
  return {
    replies: [
      {
        method: "sendMessage",
        params: {
          chat_id: user.privateChatId,
          text: `I'll remind you on ${formatDayLabel(localDateAt(until, user.timezone))} at ${formatTime(until, user.timezone)}.\nDeadline unchanged: ${deadline}.`,
        },
      },
    ],
    statements: (db) => [
      clearPendingInputStatement(db, user.id),
      setSnoozeStatement(db, user.id, task.id, until, now),
    ],
  };
}

export function reminderMenu(
  deps: SetupDeps,
  user: UserRecord,
  kind: "event" | "task",
  targetKey: string,
  title: string,
): Reaction {
  const buttons = new ActionButtons(deps.ids, user.id, deps.clock.now());
  const option = (label: string, minutes: number | null) =>
    buttons.button(label, "reminder_set", { kind, targetKey, title, minutes });
  return {
    replies: [
      keyboardMessage(
        user,
        `Remind me about ${title}:`,
        {
          inline_keyboard: [
            [option("10 min before", 10), option("30 min before", 30), option("1 hour before", 60)],
            [option("1 day before", 1440), option("No reminder", null)],
          ],
        },
        null,
      ),
    ],
    statements: (db, guard) => buttons.statements(db, guard),
  };
}

// --- Routing -------------------------------------------------------------------

export function isViewAction(action: string): boolean {
  return (
    action.startsWith("view_") || action.startsWith("snooze_") || action.startsWith("reminder_")
  );
}

export async function handleViewAction(
  deps: ViewFlowDeps,
  user: UserRecord,
  callback: InboundCallback,
  { action, payload }: UiAction,
): Promise<Reaction> {
  const ack = (text?: string) => answer(callback, text);
  const taskId = typeof payload.taskId === "string" ? payload.taskId : "";
  switch (action) {
    case "view_week": {
      const start = typeof payload.start === "string" ? payload.start : null;
      const calendarId = typeof payload.calendarId === "string" ? payload.calendarId : null;
      return combine(
        ack(),
        await weekView(deps, user, start, calendarId, start ? callback.messageId : null),
      );
    }
    case "view_month": {
      const start = typeof payload.start === "string" ? payload.start : null;
      return combine(ack(), await monthView(deps, user, start, start ? callback.messageId : null));
    }
    case "snooze_menu":
      return combine(ack(), snoozeMenu(deps, user, taskId));
    case "snooze_set":
      return combine(
        ack(),
        removeButtons(user, callback),
        await snooze(deps, user, taskId, Number(payload.until)),
      );
    case "snooze_pick": {
      const now = deps.clock.now();
      return combine(ack(), removeButtons(user, callback), {
        replies: [
          {
            method: "sendMessage",
            params: {
              chat_id: user.privateChatId,
              text: "Send a date and time, like tomorrow 9am or 9 Oct 14:00.",
            },
          },
        ],
        statements: (db) => [
          setPendingInputStatement(db, user.id, "task_snooze", now + PENDING_INPUT_TTL_MS, now, {
            taskId,
          }),
        ],
      });
    }
    case "reminder_menu":
      return combine(
        ack(),
        reminderMenu(
          deps,
          user,
          payload.kind === "task" ? "task" : "event",
          String(payload.targetKey ?? ""),
          String(payload.title ?? "this"),
        ),
      );
    case "reminder_set": {
      const minutes = typeof payload.minutes === "number" ? payload.minutes : null;
      const kind = payload.kind === "task" ? "task" : "event";
      const now = deps.clock.now();
      return combine(ack(), removeButtons(user, callback), {
        replies: [
          {
            method: "sendMessage",
            params: {
              chat_id: user.privateChatId,
              text: `Reminder for ${String(payload.title ?? "this")}: ${minutesText(minutes)}.`,
            },
          },
        ],
        statements: (db) => [
          setOverrideStatement(db, user.id, kind, String(payload.targetKey ?? ""), minutes, now),
        ],
      });
    }
    default:
      return ack("This button is no longer valid.");
  }
}

/** Typed answer for "Choose date/time" when snoozing. */
export async function handleSnoozeInput(
  deps: SetupDeps,
  user: UserRecord,
  input: InboundMessage,
  pending: PendingInput,
): Promise<Reaction> {
  const text = (input.text ?? "").trim();
  const split = text.lastIndexOf(" ");
  const todayDate = localDateAt(deps.clock.now(), user.timezone);
  const date = split === -1 ? todayDate : parseLocalDate(text.slice(0, split), todayDate);
  const time = parseWallTime(split === -1 ? text : text.slice(split + 1));
  if (!date || !time) {
    return message(user.privateChatId, "I didn't recognize that. Try tomorrow 9am or 9 Oct 14:00.");
  }
  const at = zonedInstant(date, time, user.timezone);
  if (!at.ok)
    return message(user.privateChatId, "That time doesn't exist (clocks change). Send another.");
  return snooze(deps, user, String(pending.payload.taskId ?? ""), at.instant);
}
