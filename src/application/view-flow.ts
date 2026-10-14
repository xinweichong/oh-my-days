import { parseWhen } from "../domain/parse-input";
import {
  isOverdue,
  monthStart,
  nextMonthStart,
  previousMonthStart,
  weekStart,
} from "../domain/schedule";
import { addDays, type LocalDate, localDateAt, zonedInstant } from "../domain/time";
import { appButton, appUrl } from "../miniapp/entry";
import { findCachedEvent } from "../storage/events";
import { listStoredCalendars } from "../storage/google";
import {
  clearPendingInputStatement,
  type PendingInput,
  type UiAction,
} from "../storage/interactions";
import { horizonEvents, reminderOverrides, setOverrideStatement } from "../storage/reminders";
import {
  findTask,
  listOpenTasks,
  setSnoozeStatement,
  snoozeIfUnchangedStatement,
  unsnoozeIfUnchangedStatement,
} from "../storage/tasks";
import type { UserRecord } from "../storage/users";
import type { InlineKeyboardButton } from "../telegram/api";
import { formatDayLabel, formatTime, formatWallTime } from "../telegram/format";
import type { InboundCallback, InboundMessage } from "../telegram/update";
import {
  type DayTasks,
  renderDay,
  renderPeriod,
  type SourceFor,
  tasksForDay,
  viewCalendars,
} from "./calendar-view";
import { guidedPrompt } from "./cancel";
import { whenLabel, whenQuestion } from "./choices";
import { ActionButtons, combine, message, type Reaction } from "./reactions";
import type { SetupDeps } from "./setup";
import { dueLabel, sortByDeadline, taskLabel } from "./task-flow";
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
  const now = deps.clock.now();
  const date = today(deps, user);
  const { text } = await renderDay(deps, user, date, now, {
    heading: "Today",
    includeSnoozed: false,
  });
  const buttons = new ActionButtons(deps.ids, user.id, now);
  const tasks = await tasksForDay(deps.db, user, date, now, false);
  return {
    replies: [
      keyboardMessage(
        user,
        text,
        { inline_keyboard: dayButtons(buttons, tasks, user, appUrl(deps.config)) },
        null,
      ),
    ],
    statements: (db, guard) => buttons.statements(db, guard),
  };
}

/**
 * Buttons under the agenda and /daily: views, then "Act on a task" (select a
 * task, then Done · Snooze · Edit) and "Snooze all overdue" when relevant.
 */
export function dayButtons(
  buttons: ActionButtons,
  tasks: DayTasks,
  user: Pick<UserRecord, "agendaHour">,
  appUrl: string | null = null,
): InlineKeyboardButton[][] {
  const rows = [
    [
      buttons.button("View tasks", "task_list", { listId: null, page: 0 }),
      buttons.button("View week", "view_week", {}),
    ],
  ];
  if (tasks.due.length + tasks.overdue.length > 0) {
    rows.push([buttons.button("Act on a task", "view_act", { page: 0 })]);
  }
  if (tasks.overdue.length > 0) {
    rows.push([
      buttons.button(
        `Snooze all overdue → tomorrow ${agendaTimeLabel(user)}`,
        "snooze_overdue",
        {},
      ),
    ]);
  }
  const open = appButton(appUrl);
  if (open) rows.push([open]);
  return rows;
}

const ACT_PAGE_SIZE = 8;

/** Today's due and overdue tasks as buttons; each opens that occurrence's actions. */
async function actPicker(
  deps: ViewFlowDeps,
  user: UserRecord,
  page: number,
  editMessageId: number | null,
): Promise<Reaction> {
  const now = deps.clock.now();
  const tasks = await tasksForDay(deps.db, user, today(deps, user), now, false);
  const all = [...tasks.overdue, ...tasks.due];
  if (all.length === 0) return message(user.privateChatId, "Nothing is due or overdue today.");
  const shown = all.slice(page * ACT_PAGE_SIZE, (page + 1) * ACT_PAGE_SIZE);
  const buttons = new ActionButtons(deps.ids, user.id, now);
  const overdue = new Set(tasks.overdue.map((t) => t.id));
  const rows = shown.map((t) => [
    buttons.button(
      truncate(`${overdue.has(t.id) ? "Overdue: " : ""}${taskLabel(t, user, true)}`, 60),
      "task_pick",
      { taskId: t.id },
    ),
  ]);
  const nav: InlineKeyboardButton[] = [];
  if (page > 0) nav.push(buttons.button("Previous", "view_act", { page: page - 1 }));
  if ((page + 1) * ACT_PAGE_SIZE < all.length) {
    nav.push(buttons.button("More", "view_act", { page: page + 1 }));
  }
  if (nav.length) rows.push(nav);
  return {
    replies: [keyboardMessage(user, "Which task?", { inline_keyboard: rows }, editMessageId)],
    statements: (db, guard) => buttons.statements(db, guard),
  };
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Tomorrow at the user's agenda time, so the snooze ends in the agenda. */
function tomorrowAtAgenda(now: number, user: UserRecord): number | null {
  const at = zonedInstant(
    addDays(localDateAt(now, user.timezone), 1),
    `${String(user.agendaHour).padStart(2, "0")}:00`,
    user.timezone,
  );
  return at.ok ? at.instant : null;
}

function agendaTimeLabel(user: Pick<UserRecord, "agendaHour">): string {
  return formatWallTime(`${String(user.agendaHour).padStart(2, "0")}:00`);
}

/** Asks once, with the count, before snoozing every overdue task. */
async function proposeSnoozeOverdue(deps: ViewFlowDeps, user: UserRecord): Promise<Reaction> {
  const now = deps.clock.now();
  const { overdue } = await tasksForDay(deps.db, user, today(deps, user), now, false);
  const until = tomorrowAtAgenda(now, user);
  if (overdue.length === 0 || until === null) {
    return message(user.privateChatId, "Nothing is overdue right now.");
  }
  const count = overdue.length === 1 ? "1 overdue task" : `${overdue.length} overdue tasks`;
  const buttons = new ActionButtons(deps.ids, user.id, now, 10 * 60_000);
  // Bound to this exact set: each task at the version shown.
  const items = overdue.map((t) => ({
    taskId: t.id,
    version: t.version,
    previous: t.snoozedUntil,
  }));
  return {
    replies: [
      keyboardMessage(
        user,
        `Snooze ${count} until ${when(until, user)}?\nDeadlines stay as they are.`,
        {
          inline_keyboard: [
            [
              buttons.button(`Snooze ${overdue.length}`, "snooze_overdue_confirm", {
                items,
                until,
              }),
              buttons.button("Keep", "task_keep", {}),
            ],
          ],
        },
        null,
      ),
    ],
    statements: (db, guard) => buttons.statements(db, guard),
  };
}

interface SnoozeItem {
  taskId: string;
  version: number;
  previous: number | null;
}

/** Snoozes the confirmed set; a task changed since is left alone and counted out. */
async function snoozeOverdue(
  deps: ViewFlowDeps,
  user: UserRecord,
  items: SnoozeItem[],
  until: number,
): Promise<Reaction> {
  const now = deps.clock.now();
  if (until <= now) return message(user.privateChatId, "That time has already passed.");
  const unchanged: SnoozeItem[] = [];
  for (const item of items) {
    const task = await findTask(deps.db, user.id, item.taskId);
    if (task?.status === "open" && task.version === item.version) unchanged.push(item);
  }
  if (unchanged.length === 0) {
    return message(user.privateChatId, "Those tasks changed since, so nothing was snoozed.");
  }
  const skipped = items.length - unchanged.length;
  const count = unchanged.length === 1 ? "1 overdue task" : `${unchanged.length} overdue tasks`;
  const buttons = new ActionButtons(deps.ids, user.id, now);
  const undo = buttons.button("Undo", "snooze_overdue_undo", { items: unchanged, until });
  return {
    replies: [
      keyboardMessage(
        user,
        `Snoozed ${count} until ${when(until, user)}. Deadlines unchanged.${skipped ? `\n${skipped} changed since and ${skipped === 1 ? "was" : "were"} left as ${skipped === 1 ? "it was" : "they were"}.` : ""}`,
        { inline_keyboard: [[undo]] },
        null,
      ),
    ],
    statements: (db, guard) => [
      ...unchanged.map((i) =>
        snoozeIfUnchangedStatement(db, user.id, i.taskId, i.version, until, now),
      ),
      ...buttons.statements(db, guard),
    ],
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
      : user.reminderMinutes;
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
      : user.reminderMinutes;
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
  lines.push("", `Date-only deadlines are in the ${agendaTimeLabel(user)} agenda.`);
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
  const tomorrow = tomorrowAtAgenda(now, user);
  const row: InlineKeyboardButton[] = [
    buttons.button("In 1 hour", "snooze_set", { taskId, until: now + 3_600_000 }),
  ];
  if (tomorrow !== null)
    row.push(
      buttons.button(`Tomorrow at ${agendaTimeLabel(user)}`, "snooze_set", {
        taskId,
        until: tomorrow,
      }),
    );
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
    case "view_act": {
      const page = Number(payload.page ?? 0);
      return combine(
        ack(),
        await actPicker(deps, user, page, page > 0 ? callback.messageId : null),
      );
    }
    case "snooze_overdue":
      return combine(ack(), await proposeSnoozeOverdue(deps, user));
    case "snooze_overdue_confirm": {
      const items = Array.isArray(payload.items) ? (payload.items as SnoozeItem[]) : [];
      return combine(
        ack(),
        removeButtons(user, callback),
        await snoozeOverdue(deps, user, items, Number(payload.until)),
      );
    }
    case "snooze_overdue_undo": {
      const items = Array.isArray(payload.items) ? (payload.items as SnoozeItem[]) : [];
      const until = Number(payload.until);
      const now = deps.clock.now();
      // Only tasks still carrying this snooze (and unchanged) are put back.
      return combine(ack(), removeButtons(user, callback), {
        replies: [
          {
            method: "sendMessage",
            params: {
              chat_id: user.privateChatId,
              text: "Undone: snoozes put back as they were, except tasks changed since.",
            },
          },
        ],
        statements: (db) =>
          items.map((i) =>
            unsnoozeIfUnchangedStatement(db, user.id, i.taskId, i.version, until, i.previous, now),
          ),
      });
    }
    case "snooze_set":
      return combine(
        ack(),
        removeButtons(user, callback),
        await snooze(deps, user, taskId, Number(payload.until)),
      );
    case "snooze_pick":
      return combine(
        ack(),
        removeButtons(user, callback),
        guidedPrompt(
          deps,
          user,
          "task_snooze",
          { taskId },
          "Send a date and time, like tomorrow 9am or Fri 14:00.",
        ),
      );
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
  const todayDate = localDateAt(deps.clock.now(), user.timezone);
  const taskId = String(pending.payload.taskId ?? "");
  // A time alone means today; a date needs a time.
  const options = parseWhen(text, todayDate)?.filter((o) => o.time !== null);
  if (!options?.length) {
    return message(user.privateChatId, "I didn't recognize that. Try tomorrow 9am or Fri 14:00.");
  }
  const instants = options.flatMap((o) => {
    const at = zonedInstant(o.date ?? todayDate, o.time ?? "", user.timezone);
    return at.ok ? [{ when: o, at: at.instant }] : [];
  });
  if (instants.length === 0)
    return message(user.privateChatId, "That time doesn't exist (clocks change). Send another.");
  const [only] = instants;
  if (instants.length === 1 && only) return snooze(deps, user, taskId, only.at);
  const buttons = new ActionButtons(deps.ids, user.id, deps.clock.now());
  const row = instants.map((i) =>
    buttons.button(
      whenLabel({ date: i.when.date ?? todayDate, time: i.when.time }, todayDate),
      "snooze_set",
      {
        taskId,
        until: i.at,
      },
    ),
  );
  return {
    replies: [keyboardMessage(user, whenQuestion(options), { inline_keyboard: [row] }, null)],
    statements: (db, guard) => buttons.statements(db, guard),
  };
}
