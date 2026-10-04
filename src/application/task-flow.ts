import { parseLocalDate, parseWallTime } from "../domain/parse-input";
import { describeRecurrence, type Frequency } from "../domain/recurrence";
import { DEFAULT_TASK_REMINDER_MINUTES, reminderKeys } from "../domain/schedule";
import { type Deadline, MAX_LIST_NAME, MAX_TASK_TITLE, normalizeListName } from "../domain/tasks";
import {
  addDays,
  type LocalDate,
  localDateAt,
  rfc3339,
  wallPartsAt,
  zonedInstant,
} from "../domain/time";
import type { Guard } from "../storage/guard";
import {
  clearPendingInputStatement,
  type PendingInput,
  type PendingInputKind,
  setPendingInputStatement,
  type UiAction,
} from "../storage/interactions";
import { claimReminderStatement } from "../storage/reminders";
import {
  findSeries,
  insertSeriesStatement,
  type SeriesRecord,
  updateSeriesStatement,
} from "../storage/series";
import {
  deleteListStatements,
  ensureInboxStatement,
  findTask,
  insertListStatement,
  insertTaskStatement,
  listOpenTasks,
  listTaskLists,
  type TaskChanges,
  type TaskList,
  type TaskRecord,
  updateTaskStatement,
} from "../storage/tasks";
import type { UserRecord } from "../storage/users";
import type { InlineKeyboardButton } from "../telegram/api";
import { formatDayLabel, formatShortStart } from "../telegram/format";
import type { InboundCallback, InboundMessage } from "../telegram/update";
import { ActionButtons, combine, message, type Reaction } from "./reactions";
import { recurrenceOf } from "./series";
import { PENDING_INPUT_TTL_MS, type SetupDeps } from "./setup";
import { projectTaskStatement } from "./task-projection";
import { answer, keyboardMessage, removeButtons } from "./ui";

/**
 * Structured task commands (no AI). Task state is application-owned, so changes
 * apply immediately in D1 and their deadline markers follow through the
 * projection operation. Undo and confirmations are bound to the task version.
 */

const PAGE_SIZE = 8;

/** A task being created, or a deadline being changed. */
interface TaskDraft {
  title: string;
  listId?: string;
  date?: LocalDate;
  /** Present when changing an existing task's deadline. */
  taskId?: string;
}

function readDraft(payload: Record<string, unknown>): TaskDraft | null {
  const draft = payload.draft as TaskDraft | undefined;
  return draft && typeof draft.title === "string" ? draft : null;
}

export function dueLabel(deadline: Deadline, timeZone: string): string {
  switch (deadline.kind) {
    case "none":
      return "No deadline";
    case "date":
      return `Due ${formatDayLabel(deadline.date)}`;
    case "datetime":
      return `Due ${formatShortStart(
        {
          start: { dateTime: rfc3339(deadline.at, deadline.timeZone), timeZone: deadline.timeZone },
        },
        timeZone,
      )}`;
  }
}

// --- Entry points ----------------------------------------------------------------

function blocked(user: UserRecord): Reaction | null {
  return user.setupStep === "done"
    ? null
    : message(user.privateChatId, "Finish setup first: send /start to continue.");
}

function ensureInbox(deps: SetupDeps, user: UserRecord): Reaction {
  const now = deps.clock.now();
  return { replies: [], statements: (db) => [ensureInboxStatement(db, deps.ids, user.id, now)] };
}

export async function taskMenu(deps: SetupDeps, user: UserRecord): Promise<Reaction> {
  const stop = blocked(user);
  if (stop) return stop;
  const buttons = new ActionButtons(deps.ids, user.id, deps.clock.now());
  return combine(ensureInbox(deps, user), {
    replies: [
      keyboardMessage(
        user,
        "Tasks",
        {
          inline_keyboard: [
            [
              buttons.button("New task", "task_new", {}),
              buttons.button("Open tasks", "task_list", { page: 0 }),
            ],
            [buttons.button("Lists", "task_lists", {})],
          ],
        },
        null,
      ),
    ],
    statements: (db, guard) => buttons.statements(db, guard),
  });
}

export async function tasksCommand(deps: SetupDeps, user: UserRecord): Promise<Reaction> {
  const stop = blocked(user);
  if (stop) return stop;
  await ensureInboxStatement(deps.db, deps.ids, user.id, deps.clock.now()).run();
  return tasksView(deps, user, null, 0, null);
}

// --- Views -----------------------------------------------------------------------

async function tasksView(
  deps: SetupDeps,
  user: UserRecord,
  listId: string | null,
  page: number,
  editMessageId: number | null,
): Promise<Reaction> {
  const lists = await listTaskLists(deps.db, user.id);
  const list = lists.find((l) => l.id === listId) ?? null;
  const all = sortByDeadline(
    await listOpenTasks(deps.db, user.id, list?.id ?? null),
    user.timezone,
  );
  const total = all.length;
  const tasks = all.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const buttons = new ActionButtons(deps.ids, user.id, deps.clock.now());
  const rows: InlineKeyboardButton[][] = tasks.map((t) => [
    buttons.button(truncate(taskLabel(t, user, list === null), 60), "task_pick", { taskId: t.id }),
  ]);
  const nav: InlineKeyboardButton[] = [];
  if (page > 0)
    nav.push(buttons.button("Previous", "task_list", { listId: list?.id ?? null, page: page - 1 }));
  if ((page + 1) * PAGE_SIZE < total) {
    nav.push(buttons.button("More", "task_list", { listId: list?.id ?? null, page: page + 1 }));
  }
  if (nav.length) rows.push(nav);
  // Filter by list.
  const filters = [
    ...(list ? [buttons.button("All lists", "task_list", { listId: null, page: 0 })] : []),
    ...lists
      .filter((l) => l.id !== list?.id)
      .slice(0, 6)
      .map((l) => buttons.button(l.name, "task_list", { listId: l.id, page: 0 })),
  ];
  for (let i = 0; i < filters.length; i += 3) rows.push(filters.slice(i, i + 3));
  if (list && !list.isInbox)
    rows.push([buttons.button(`Delete list ${list.name}`, "list_delete", { listId: list.id })]);

  const heading = list ? `${list.name}: ${total} open` : `Open tasks: ${total}`;
  const text = total === 0 ? `${heading}\n\nNothing open${list ? " in this list" : ""}.` : heading;
  return {
    replies: [keyboardMessage(user, text, { inline_keyboard: rows }, editMessageId)],
    statements: (db, guard) => buttons.statements(db, guard),
  };
}

/**
 * Deadlines first, earliest first (a date-only deadline sorts at the start of
 * its day in the user's zone), then tasks without deadlines in creation order.
 */
export function sortByDeadline(tasks: TaskRecord[], timeZone: string): TaskRecord[] {
  const key = (t: TaskRecord) => {
    if (t.deadline.kind === "datetime") return t.deadline.at;
    if (t.deadline.kind === "date") {
      const start = zonedInstant(t.deadline.date, "00:00", timeZone);
      return start.ok ? start.instant : Number.POSITIVE_INFINITY;
    }
    return Number.POSITIVE_INFINITY;
  };
  return [...tasks].sort((a, b) => key(a) - key(b));
}

function taskLabel(task: TaskRecord, user: UserRecord, withList: boolean): string {
  const list = withList ? `[${task.listName}] ` : "";
  const due =
    task.deadline.kind === "none"
      ? ""
      : ` · ${dueLabel(task.deadline, user.timezone).replace(/^Due /, "")}`;
  return `${list}${task.title}${due}`;
}

async function taskCard(deps: SetupDeps, user: UserRecord, taskId: string): Promise<Reaction> {
  const task = await findTask(deps.db, user.id, taskId);
  if (!task) return message(user.privateChatId, "I can't find that task anymore.");
  const status =
    task.status === "completed" ? "\nCompleted" : task.status === "cancelled" ? "\nCancelled" : "";
  const series = task.seriesId ? await findSeries(deps.db, user.id, task.seriesId) : null;
  const repeats = series
    ? `\nRepeats: ${describeRecurrence(recurrenceOf(series))}${series.status === "stopped" ? " (stopped)" : ""}`
    : "";
  const text = `${task.title}\n${task.listName} · ${dueLabel(task.deadline, user.timezone)}${repeats}${status}`;
  const buttons = new ActionButtons(deps.ids, user.id, deps.clock.now());
  const ref = { taskId: task.id, version: task.version };
  const rows: InlineKeyboardButton[][] =
    task.status === "open"
      ? [
          [
            buttons.button("Done", "task_done", ref),
            buttons.button("Snooze", "snooze_menu", { taskId: task.id }),
            buttons.button("Edit", "task_edit", ref),
          ],
          [
            ...(task.deadline.kind === "datetime"
              ? [
                  buttons.button("Reminder", "reminder_menu", {
                    kind: "task",
                    targetKey: task.id,
                    title: task.title,
                  }),
                ]
              : []),
            buttons.button("Cancel task", "task_cancel", ref),
          ],
        ]
      : [[buttons.button(task.status === "completed" ? "Reopen" : "Restore", "task_reopen", ref)]];
  if (series?.status === "active") {
    rows.push([buttons.button("Series", "series_menu", { seriesId: series.id })]);
  }
  return {
    about: { kind: "task", taskId: task.id },
    replies: [keyboardMessage(user, text, { inline_keyboard: rows }, null)],
    statements: (db, guard) => buttons.statements(db, guard),
  };
}

async function listsView(deps: SetupDeps, user: UserRecord): Promise<Reaction> {
  const lists = await listTaskLists(deps.db, user.id);
  const buttons = new ActionButtons(deps.ids, user.id, deps.clock.now());
  const rows = lists.map((l) => [
    buttons.button(`${l.name} (${l.openCount} open)`, "task_list", { listId: l.id, page: 0 }),
  ]);
  rows.push([buttons.button("New list", "list_new", {})]);
  return {
    replies: [keyboardMessage(user, "Lists", { inline_keyboard: rows }, null)],
    statements: (db, guard) => buttons.statements(db, guard),
  };
}

// --- Asking ----------------------------------------------------------------------

function ask(
  deps: SetupDeps,
  user: UserRecord,
  kind: PendingInputKind,
  payload: Record<string, unknown>,
  text: string,
  rows: InlineKeyboardButton[][] = [],
  buttons?: ActionButtons,
): Reaction {
  const now = deps.clock.now();
  return {
    replies: [
      rows.length
        ? keyboardMessage(user, text, { inline_keyboard: rows }, null)
        : { method: "sendMessage", params: { chat_id: user.privateChatId, text } },
    ],
    statements: (db, guard) => [
      setPendingInputStatement(db, user.id, kind, now + PENDING_INPUT_TTL_MS, now, payload),
      ...(buttons?.statements(db, guard) ?? []),
    ],
  };
}

function askList(deps: SetupDeps, user: UserRecord, draft: TaskDraft, lists: TaskList[]): Reaction {
  const buttons = new ActionButtons(deps.ids, user.id, deps.clock.now());
  const rows = lists.map((l) => [
    buttons.button(l.name, "task_draft_list", { draft, listId: l.id }),
  ]);
  return {
    replies: [
      keyboardMessage(user, `Which list is ${draft.title} in?`, { inline_keyboard: rows }, null),
    ],
    statements: (db, guard) => [
      clearPendingInputStatement(db, user.id),
      ...buttons.statements(db, guard),
    ],
  };
}

function askDue(deps: SetupDeps, user: UserRecord, draft: TaskDraft): Reaction {
  const today = localDateAt(deps.clock.now(), user.timezone);
  const buttons = new ActionButtons(deps.ids, user.id, deps.clock.now());
  const day = (offset: number) => {
    const date = addDays(today, offset);
    const prefix = offset === 0 ? "Today · " : offset === 1 ? "Tomorrow · " : "";
    return buttons.button(`${prefix}${formatDayLabel(date)}`, "task_draft_date", { draft, date });
  };
  const rows = [
    [buttons.button("No deadline", "task_draft_none", { draft })],
    [day(0), day(1)],
    [day(2), day(3)],
  ];
  return ask(
    deps,
    user,
    "task_due_date",
    { draft },
    `When is ${draft.title} due? Or type a date, like 9 Oct or 9/10.`,
    rows,
    buttons,
  );
}

function askDueTime(deps: SetupDeps, user: UserRecord, draft: TaskDraft): Reaction {
  const buttons = new ActionButtons(deps.ids, user.id, deps.clock.now());
  return ask(
    deps,
    user,
    "task_due_time",
    { draft },
    `Due at a specific time on ${formatDayLabel(draft.date ?? "")}? Send a time like 15:00 or 3pm.`,
    [[buttons.button("Any time that day", "task_draft_whole_day", { draft })]],
    buttons,
  );
}

// --- Changes -----------------------------------------------------------------------

/**
 * A deadline set inside its reminder window: the confirmation is the
 * approaching notice, so no separate reminder follows.
 */
function confirmedOnCreate(
  db: D1Database,
  userId: string,
  taskId: string,
  deadline: Deadline,
  now: number,
  claimedBy: string,
  guard: Guard,
): D1PreparedStatement[] {
  if (deadline.kind !== "datetime") return [];
  const due = deadline.at - DEFAULT_TASK_REMINDER_MINUTES * 60_000;
  if (deadline.at <= now || due > now) return [];
  return [
    claimReminderStatement(
      db,
      userId,
      reminderKeys.taskDue(taskId, deadline.at, DEFAULT_TASK_REMINDER_MINUTES),
      "confirmed_on_create",
      claimedBy,
      now,
      guard,
    ),
  ];
}

function needsProjection(task: TaskRecord, changes: TaskChanges): boolean {
  const deadline = changes.deadline ?? task.deadline;
  return task.projection !== null || deadline.kind !== "none";
}

/**
 * Applies a version-checked change, queues the marker update, and replies with
 * the result and an Undo bound to the resulting version.
 */
export function change(
  deps: SetupDeps,
  user: UserRecord,
  task: TaskRecord,
  changes: TaskChanges,
  before: TaskChanges,
  text: string,
  undo: { label: string } | null = { label: "Undo" },
): Reaction {
  const now = deps.clock.now();
  const version = task.version + 1;
  const buttons = new ActionButtons(deps.ids, user.id, now);
  const keyboard = undo
    ? {
        inline_keyboard: [
          [buttons.button(undo.label, "task_undo", { taskId: task.id, version, before })],
        ],
      }
    : null;
  return {
    about: { kind: "task", taskId: task.id },
    replies: [
      keyboard
        ? keyboardMessage(user, text, keyboard, null)
        : { method: "sendMessage", params: { chat_id: user.privateChatId, text } },
    ],
    statements: (db, guard) => [
      updateTaskStatement(db, user.id, task.id, task.version, changes, now, guard),
      ...(changes.deadline
        ? confirmedOnCreate(
            db,
            user.id,
            task.id,
            changes.deadline,
            now,
            `task:${task.id}:${version}`,
            guard,
          )
        : []),
      ...(needsProjection(task, changes)
        ? [
            projectTaskStatement(
              db,
              deps.ids,
              { ...task, title: changes.title ?? task.title },
              version,
              now,
              guard,
            ),
          ]
        : []),
      ...buttons.statements(db, guard),
    ],
  };
}

async function createTask(
  deps: SetupDeps,
  user: UserRecord,
  draft: TaskDraft,
  deadline: Deadline,
): Promise<Reaction> {
  const lists = await listTaskLists(deps.db, user.id);
  const list = lists.find((l) => l.id === draft.listId) ?? lists.find((l) => l.isInbox);
  if (!list)
    return message(user.privateChatId, "Your lists aren't ready yet. Send /task to try again.");
  const now = deps.clock.now();
  const id = deps.ids.next();
  const task = { id, userId: user.id, title: draft.title };
  const buttons = new ActionButtons(deps.ids, user.id, now);
  const text = `Task added to ${list.name}: ${draft.title}.\n${dueLabel(deadline, user.timezone)}.`;
  return {
    about: { kind: "task", taskId: id },
    replies: [
      keyboardMessage(
        user,
        text,
        {
          inline_keyboard: [
            [buttons.button("Undo", "task_undo_create", { taskId: id, version: 1 })],
          ],
        },
        null,
      ),
    ],
    statements: (db, guard) => [
      clearPendingInputStatement(db, user.id),
      insertTaskStatement(
        db,
        {
          id,
          userId: user.id,
          listId: list.id,
          title: draft.title,
          deadline,
          status: "open",
          origin: "telegram",
        },
        now,
        guard,
      ),
      ...(deadline.kind === "none"
        ? []
        : [projectTaskStatement(db, deps.ids, task, 1, now, guard)]),
      ...confirmedOnCreate(db, user.id, id, deadline, now, `task:${id}:1`, guard),
      ...buttons.statements(db, guard),
    ],
  };
}

async function setDeadline(
  deps: SetupDeps,
  user: UserRecord,
  draft: TaskDraft,
  deadline: Deadline,
): Promise<Reaction> {
  if (!draft.taskId) {
    return deadline.kind === "none"
      ? createTask(deps, user, draft, deadline)
      : askRepeat(deps, user, draft, deadline);
  }
  const task = await findTask(deps.db, user.id, draft.taskId);
  if (task?.status !== "open")
    return message(user.privateChatId, "That task can't be changed anymore.");
  return combine(
    { replies: [], statements: (db) => [clearPendingInputStatement(db, user.id)] },
    change(
      deps,
      user,
      task,
      { deadline },
      { deadline: task.deadline },
      `Deadline for ${task.title}: ${dueLabel(deadline, user.timezone).replace(/^Due /, "")}.`,
    ),
  );
}

function timedDeadline(
  user: UserRecord,
  date: LocalDate,
  time: string,
): { ok: true; deadline: Deadline } | { ok: false; text: string } {
  const at = zonedInstant(date, time, user.timezone);
  if (!at.ok) {
    return {
      ok: false,
      text: `${time} doesn't exist on ${formatDayLabel(date)} in ${user.timezone} (clocks change). Send another time.`,
    };
  }
  return { ok: true, deadline: { kind: "datetime", at: at.instant, timeZone: user.timezone } };
}

/** A confirmation bound to the task version: the action applies only if nothing changed. */
export function confirmPrompt(
  deps: SetupDeps,
  user: UserRecord,
  text: string,
  confirmLabel: string,
  action: string,
  payload: Record<string, unknown>,
): Reaction {
  const buttons = new ActionButtons(deps.ids, user.id, deps.clock.now(), 10 * 60_000);
  return {
    replies: [
      keyboardMessage(
        user,
        text,
        {
          inline_keyboard: [
            [
              buttons.button(confirmLabel, action, payload),
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

// --- Buttons -------------------------------------------------------------------

export function isTaskAction(action: string): boolean {
  return action.startsWith("task_") || action.startsWith("list_") || action.startsWith("series_");
}

export async function handleTaskAction(
  deps: SetupDeps,
  user: UserRecord,
  callback: InboundCallback,
  { action, payload }: UiAction,
): Promise<Reaction> {
  const stop = blocked(user);
  if (stop) return combine(answer(callback), stop);
  const ack = (text?: string) => answer(callback, text);
  const done = removeButtons(user, callback);
  const taskId = typeof payload.taskId === "string" ? payload.taskId : "";
  const version = Number(payload.version);
  /** The task, only if it is still at the version the button was made for. */
  const current = async () => {
    const task = await findTask(deps.db, user.id, taskId);
    return task && task.version === version ? task : null;
  };
  const stale = () => ack("This task has changed since. Open it again from /tasks.");

  switch (action) {
    case "task_new":
      return combine(ack(), ask(deps, user, "task_title", {}, "What's the task?"));
    case "task_list":
      return combine(
        ack(),
        await tasksView(
          deps,
          user,
          typeof payload.listId === "string" ? payload.listId : null,
          Number(payload.page ?? 0),
          callback.messageId,
        ),
      );
    case "task_lists":
      return combine(ack(), await listsView(deps, user));
    case "task_pick":
      return combine(ack(), await taskCard(deps, user, taskId));

    case "task_draft_list": {
      const draft = readDraft(payload);
      if (!draft || typeof payload.listId !== "string")
        return ack("This button is no longer valid.");
      return combine(ack(), done, askDue(deps, user, { ...draft, listId: payload.listId }));
    }
    case "task_draft_none": {
      const draft = readDraft(payload);
      if (!draft) return ack("This button is no longer valid.");
      return combine(ack(), done, await setDeadline(deps, user, draft, { kind: "none" }));
    }
    case "task_draft_date": {
      const draft = readDraft(payload);
      if (!draft || typeof payload.date !== "string") return ack("This button is no longer valid.");
      return combine(ack(), done, askDueTime(deps, user, { ...draft, date: payload.date }));
    }
    case "task_draft_whole_day": {
      const draft = readDraft(payload);
      if (!draft?.date) return ack("This button is no longer valid.");
      return combine(
        ack(),
        done,
        await setDeadline(deps, user, draft, { kind: "date", date: draft.date }),
      );
    }

    case "task_done": {
      const task = await current();
      if (task?.status !== "open") return stale();
      return combine(
        ack(),
        done,
        change(
          deps,
          user,
          task,
          { status: "completed" },
          { status: "open" },
          `Completed: ${task.title}.`,
        ),
      );
    }
    case "task_reopen": {
      const task = await current();
      if (!task || task.status === "open") return stale();
      return combine(
        ack(),
        done,
        change(
          deps,
          user,
          task,
          { status: "open" },
          { status: task.status },
          `Reopened: ${task.title}.`,
        ),
      );
    }
    case "task_edit": {
      const task = await current();
      if (task?.status !== "open") return stale();
      const buttons = new ActionButtons(deps.ids, user.id, deps.clock.now());
      const ref = { taskId, version };
      const rows = [
        [
          buttons.button("Rename", "task_rename", ref),
          buttons.button("Change deadline", "task_redate", ref),
        ],
        [
          ...(task.deadline.kind === "none"
            ? []
            : [buttons.button("Remove deadline", "task_undate", ref)]),
          buttons.button("Move to list", "task_move", ref),
        ],
      ];
      return combine(ack(), done, {
        replies: [keyboardMessage(user, `Edit ${task.title}`, { inline_keyboard: rows }, null)],
        statements: (db, guard) => buttons.statements(db, guard),
      });
    }
    case "task_rename": {
      const task = await current();
      if (!task) return stale();
      return combine(
        ack(),
        done,
        ask(deps, user, "task_rename", { taskId, version }, `Send the new name for ${task.title}.`),
      );
    }
    case "task_redate": {
      const task = await current();
      if (!task) return stale();
      return combine(ack(), done, askDue(deps, user, { title: task.title, taskId }));
    }
    case "task_undate": {
      const task = await current();
      if (!task || task.deadline.kind === "none") return stale();
      return combine(
        ack(),
        done,
        change(
          deps,
          user,
          task,
          { deadline: { kind: "none" } },
          { deadline: task.deadline },
          `Deadline removed: ${task.title}. No deadline.`,
        ),
      );
    }
    case "task_move": {
      const task = await current();
      if (!task) return stale();
      const lists = (await listTaskLists(deps.db, user.id)).filter((l) => l.id !== task.listId);
      if (lists.length === 0)
        return ack("There are no other lists. Create one from /task → Lists.");
      const buttons = new ActionButtons(deps.ids, user.id, deps.clock.now());
      const rows = lists.map((l) => [
        buttons.button(l.name, "task_move_to", { taskId, version, listId: l.id }),
      ]);
      return combine(ack(), done, {
        replies: [
          keyboardMessage(
            user,
            `Move ${task.title} to which list?`,
            { inline_keyboard: rows },
            null,
          ),
        ],
        statements: (db, guard) => buttons.statements(db, guard),
      });
    }
    case "task_move_to": {
      const task = await current();
      const list = (await listTaskLists(deps.db, user.id)).find((l) => l.id === payload.listId);
      if (!task || !list) return stale();
      return combine(
        ack(),
        done,
        change(
          deps,
          user,
          task,
          { listId: list.id },
          { listId: task.listId },
          `Moved ${task.title} to ${list.name}.`,
        ),
      );
    }
    case "task_cancel": {
      const task = await current();
      if (task?.status !== "open") return stale();
      const marker =
        task.deadline.kind === "none" ? "" : " Its deadline is removed from Google Calendar.";
      return combine(
        ack(),
        done,
        confirmPrompt(
          deps,
          user,
          `Cancel task: ${task.title}?${marker}`,
          "Cancel task",
          "task_cancel_confirm",
          { taskId, version },
        ),
      );
    }
    case "task_cancel_confirm": {
      const task = await current();
      if (task?.status !== "open") return stale();
      return combine(
        ack(),
        done,
        change(
          deps,
          user,
          task,
          { status: "cancelled" },
          { status: "open" },
          `Cancelled: ${task.title}.`,
          { label: "Restore" },
        ),
      );
    }
    case "task_keep":
      return combine(ack("Nothing was changed."), done);

    case "task_undo": {
      const task = await current();
      if (!task) return ack("Undo isn't available: the task changed since.");
      const before = (payload.before ?? {}) as TaskChanges;
      const after: TaskChanges = {};
      if (before.title !== undefined) after.title = task.title;
      if (before.listId !== undefined) after.listId = task.listId;
      if (before.deadline !== undefined) after.deadline = task.deadline;
      if (before.status !== undefined) after.status = task.status;
      return combine(
        ack(),
        done,
        change(deps, user, task, before, after, `Undone: ${task.title}.`, null),
      );
    }
    case "task_undo_create": {
      const task = await current();
      if (!task) return ack("Undo isn't available: the task changed since.");
      // Removing a task is a cancellation, so it is confirmed first.
      return combine(
        ack(),
        done,
        confirmPrompt(deps, user, `Remove task: ${task.title}?`, "Remove", "task_cancel_confirm", {
          taskId,
          version,
        }),
      );
    }

    case "task_repeat": {
      const draft = readDraft(payload);
      const deadline = payload.deadline as Deadline | undefined;
      if (!draft || !deadline) return ack("This button is no longer valid.");
      const freq = typeof payload.freq === "string" ? (payload.freq as Frequency) : null;
      return combine(
        ack(),
        done,
        freq
          ? await createSeries(deps, user, draft, deadline, freq)
          : await createTask(deps, user, draft, deadline),
      );
    }
    case "series_menu": {
      const series = await findSeries(deps.db, user.id, String(payload.seriesId ?? ""));
      if (series?.status !== "active") return ack("This series has stopped.");
      const buttons = new ActionButtons(deps.ids, user.id, deps.clock.now());
      const ref = { seriesId: series.id, version: series.version };
      return combine(ack(), {
        replies: [
          keyboardMessage(
            user,
            `${series.title}\n${describeRecurrence(recurrenceOf(series))}`,
            {
              inline_keyboard: [
                [
                  buttons.button("Rename series", "series_rename", ref),
                  buttons.button("Stop series", "series_stop", ref),
                ],
              ],
            },
            null,
          ),
        ],
        statements: (db, guard) => buttons.statements(db, guard),
      });
    }
    case "series_rename": {
      const series = await currentSeries(deps, user, payload);
      if (!series) return ack("This series has changed since.");
      return combine(
        ack(),
        done,
        ask(
          deps,
          user,
          "series_rename",
          { seriesId: series.id, version: series.version },
          `Send the new name for every open occurrence of ${series.title}.`,
        ),
      );
    }
    case "series_rename_confirm": {
      const series = await currentSeries(deps, user, payload);
      if (!series || typeof payload.title !== "string")
        return ack("This series has changed since.");
      return combine(ack(), done, await renameSeries(deps, user, series, payload.title));
    }
    case "series_stop": {
      const series = await currentSeries(deps, user, payload);
      if (!series) return ack("This series has changed since.");
      const today = localDateAt(deps.clock.now(), user.timezone);
      const open = await openOccurrences(deps, user, series.id);
      const overdue = open.filter((t) => (t.occurrenceDate ?? "") < today).length;
      const keep = overdue
        ? ` ${overdue} earlier occurrence${overdue === 1 ? " stays" : "s stay"} open.`
        : "";
      return combine(
        ack(),
        done,
        confirmPrompt(
          deps,
          user,
          `Stop repeating ${series.title}? Open occurrences from today on are cancelled.${keep}`,
          "Stop series",
          "series_stop_confirm",
          { seriesId: series.id, version: series.version },
        ),
      );
    }
    case "series_stop_confirm": {
      const series = await currentSeries(deps, user, payload);
      if (!series) return ack("This series has changed since.");
      return combine(ack(), done, await stopSeries(deps, user, series));
    }

    case "list_new":
      return combine(
        ack(),
        ask(
          deps,
          user,
          "list_name",
          {},
          `Send a name for the new list (up to ${MAX_LIST_NAME} characters).`,
        ),
      );
    case "list_delete": {
      const list = (await listTaskLists(deps.db, user.id)).find(
        (l) => l.id === payload.listId && !l.isInbox,
      );
      if (!list) return ack("This list no longer exists.");
      return combine(
        ack(),
        confirmPrompt(
          deps,
          user,
          `Delete list ${list.name}? Its ${list.openCount} open tasks move to Inbox; no tasks are deleted.`,
          "Delete list",
          "list_delete_confirm",
          { listId: list.id },
        ),
      );
    }
    case "list_delete_confirm":
      return combine(ack(), done, await deleteList(deps, user, String(payload.listId ?? "")));
    default:
      return ack("This button is no longer valid.");
  }
}

async function deleteList(deps: SetupDeps, user: UserRecord, listId: string): Promise<Reaction> {
  const lists = await listTaskLists(deps.db, user.id);
  const list = lists.find((l) => l.id === listId && !l.isInbox);
  const inbox = lists.find((l) => l.isInbox);
  if (!list || !inbox) return message(user.privateChatId, "This list no longer exists.");
  const { results } = await deps.db
    .prepare(
      "SELECT id, title, version FROM tasks WHERE user_id = ? AND list_id = ? AND (due_kind <> 'none' OR projection_event_id IS NOT NULL)",
    )
    .bind(user.id, list.id)
    .all<{ id: string; title: string; version: number }>();
  const now = deps.clock.now();
  return {
    replies: [
      {
        method: "sendMessage",
        params: {
          chat_id: user.privateChatId,
          text: `Deleted list ${list.name}. Its tasks are now in Inbox.`,
        },
      },
    ],
    statements: (db, guard) => [
      ...deleteListStatements(db, user.id, list.id, inbox.id, now),
      // Their markers now show [Inbox].
      ...results.map((t) =>
        projectTaskStatement(
          db,
          deps.ids,
          { id: t.id, userId: user.id, title: t.title },
          t.version + 1,
          now,
          guard,
        ),
      ),
    ],
  };
}

// --- Typed answers -------------------------------------------------------------

export function isTaskInput(kind: PendingInputKind): boolean {
  return kind.startsWith("task_") || kind === "list_name" || kind === "series_rename";
}

export async function handleTaskInput(
  deps: SetupDeps,
  user: UserRecord,
  input: InboundMessage,
  pending: PendingInput,
): Promise<Reaction> {
  const text = (input.text ?? "").trim();
  const draft = readDraft(pending.payload);
  const today = localDateAt(deps.clock.now(), user.timezone);
  const expired = () =>
    combine(
      { replies: [], statements: (db) => [clearPendingInputStatement(db, user.id)] },
      message(user.privateChatId, "That request expired. Send /task to start again."),
    );

  switch (pending.kind) {
    case "task_title": {
      if (text.length === 0 || text.length > MAX_TASK_TITLE) {
        return message(user.privateChatId, `Send a task of up to ${MAX_TASK_TITLE} characters.`);
      }
      const lists = await listTaskLists(deps.db, user.id);
      const next: TaskDraft = { title: text };
      return lists.length > 1 ? askList(deps, user, next, lists) : askDue(deps, user, next);
    }
    case "task_due_date": {
      if (!draft) return expired();
      if (/^(no|none|no deadline)$/i.test(text))
        return setDeadline(deps, user, draft, { kind: "none" });
      const date = parseLocalDate(text, today);
      if (!date)
        return message(
          user.privateChatId,
          "I didn't recognize that date. Try 9 Oct, 9/10, or 2026-10-09.",
        );
      return askDueTime(deps, user, { ...draft, date });
    }
    case "task_due_time": {
      if (!draft?.date) return expired();
      const time = parseWallTime(text);
      if (!time)
        return message(user.privateChatId, "I didn't recognize that time. Try 15:00 or 3pm.");
      const deadline = timedDeadline(user, draft.date, time);
      if (!deadline.ok) return message(user.privateChatId, deadline.text);
      return setDeadline(deps, user, draft, deadline.deadline);
    }
    case "task_rename": {
      if (text.length === 0 || text.length > MAX_TASK_TITLE) {
        return message(user.privateChatId, `Send a name of up to ${MAX_TASK_TITLE} characters.`);
      }
      const task = await findTask(deps.db, user.id, String(pending.payload.taskId ?? ""));
      if (!task || task.version !== Number(pending.payload.version)) return expired();
      return combine(
        { replies: [], statements: (db) => [clearPendingInputStatement(db, user.id)] },
        change(deps, user, task, { title: text }, { title: task.title }, `Renamed: ${text}.`),
      );
    }
    case "series_rename": {
      if (text.length === 0 || text.length > MAX_TASK_TITLE) {
        return message(user.privateChatId, `Send a name of up to ${MAX_TASK_TITLE} characters.`);
      }
      const series = await currentSeries(deps, user, pending.payload);
      if (!series) return expired();
      // Whole-series changes are confirmed first (spec §4).
      return combine(
        { replies: [], statements: (db) => [clearPendingInputStatement(db, user.id)] },
        confirmPrompt(
          deps,
          user,
          `Rename every open occurrence of ${series.title} to ${text}?`,
          "Rename series",
          "series_rename_confirm",
          { seriesId: series.id, version: series.version, title: text },
        ),
      );
    }
    case "list_name": {
      const lists = await listTaskLists(deps.db, user.id);
      if (text.length === 0 || text.length > MAX_LIST_NAME || /[[\]]/.test(text)) {
        return message(
          user.privateChatId,
          `Send a list name of up to ${MAX_LIST_NAME} characters, without [ or ].`,
        );
      }
      if (lists.some((l) => normalizeListName(l.name) === normalizeListName(text))) {
        return message(
          user.privateChatId,
          "A list with that name already exists. Send another name.",
        );
      }
      const now = deps.clock.now();
      return {
        replies: [
          {
            method: "sendMessage",
            params: { chat_id: user.privateChatId, text: `List created: ${text}.` },
          },
        ],
        statements: (db) => [
          clearPendingInputStatement(db, user.id),
          insertListStatement(db, deps.ids.next(), user.id, text, now),
        ],
      };
    }
    default:
      return expired();
  }
}

// --- Recurring tasks ---------------------------------------------------------------

function askRepeat(
  deps: SetupDeps,
  user: UserRecord,
  draft: TaskDraft,
  deadline: Deadline,
): Reaction {
  const buttons = new ActionButtons(deps.ids, user.id, deps.clock.now());
  const option = (label: string, freq: Frequency | null) =>
    buttons.button(label, "task_repeat", { draft, deadline, freq });
  return {
    replies: [
      keyboardMessage(
        user,
        `Does ${draft.title} repeat?`,
        {
          inline_keyboard: [
            [option("Doesn't repeat", null)],
            [option("Daily", "daily"), option("Weekly", "weekly")],
            [option("Monthly", "monthly"), option("Yearly", "yearly")],
          ],
        },
        null,
      ),
    ],
    statements: (db, guard) => [
      clearPendingInputStatement(db, user.id),
      ...buttons.statements(db, guard),
    ],
  };
}

async function createSeries(
  deps: SetupDeps,
  user: UserRecord,
  draft: TaskDraft,
  deadline: Deadline,
  freq: Frequency,
): Promise<Reaction> {
  if (deadline.kind === "none") return createTask(deps, user, draft, deadline);
  const lists = await listTaskLists(deps.db, user.id);
  const list = lists.find((l) => l.id === draft.listId) ?? lists.find((l) => l.isInbox);
  if (!list)
    return message(user.privateChatId, "Your lists aren't ready yet. Send /task to try again.");
  const now = deps.clock.now();
  const anchor = deadline.kind === "date" ? deadline.date : localDateAt(deadline.at, user.timezone);
  const dueTime =
    deadline.kind === "datetime"
      ? (() => {
          const w = wallPartsAt(deadline.at, user.timezone);
          return `${String(w.hour).padStart(2, "0")}:${String(w.minute).padStart(2, "0")}`;
        })()
      : null;
  const seriesId = deps.ids.next();
  const taskId = deps.ids.next();
  const rule = { freq, interval: 1, anchor };
  const buttons = new ActionButtons(deps.ids, user.id, now);
  return {
    about: { kind: "task", taskId },
    replies: [
      keyboardMessage(
        user,
        `Recurring task added to ${list.name}: ${draft.title}.\n${describeRecurrence(rule)}. First ${dueLabel(deadline, user.timezone).replace(/^Due /, "due ")}.`,
        { inline_keyboard: [[buttons.button("Undo", "series_stop", { seriesId, version: 1 })]] },
        null,
      ),
    ],
    statements: (db, guard) => [
      insertSeriesStatement(
        db,
        {
          id: seriesId,
          userId: user.id,
          listId: list.id,
          title: draft.title,
          freq,
          interval: 1,
          anchorDate: anchor,
          dueTime,
          timezone: user.timezone,
          materializedThrough: anchor,
        },
        now,
        guard,
      ),
      insertTaskStatement(
        db,
        {
          id: taskId,
          userId: user.id,
          listId: list.id,
          title: draft.title,
          deadline,
          status: "open",
          origin: "telegram",
          occurrence: { seriesId, date: anchor },
        },
        now,
        guard,
      ),
      projectTaskStatement(
        db,
        deps.ids,
        { id: taskId, userId: user.id, title: draft.title },
        1,
        now,
        guard,
      ),
      ...buttons.statements(db, guard),
    ],
  };
}

async function currentSeries(deps: SetupDeps, user: UserRecord, payload: Record<string, unknown>) {
  const series = await findSeries(deps.db, user.id, String(payload.seriesId ?? ""));
  return series && series.version === Number(payload.version) && series.status === "active"
    ? series
    : null;
}

async function openOccurrences(
  deps: SetupDeps,
  user: UserRecord,
  seriesId: string,
): Promise<TaskRecord[]> {
  return (await listOpenTasks(deps.db, user.id, null)).filter((t) => t.seriesId === seriesId);
}

/** Renames the series and every open occurrence (each version-checked), updating markers. */
async function renameSeries(
  deps: SetupDeps,
  user: UserRecord,
  series: SeriesRecord,
  title: string,
): Promise<Reaction> {
  const now = deps.clock.now();
  const open = await openOccurrences(deps, user, series.id);
  return {
    replies: [
      {
        method: "sendMessage",
        params: {
          chat_id: user.privateChatId,
          text: `Renamed the series to ${title}, including ${open.length} open occurrence${open.length === 1 ? "" : "s"}.`,
        },
      },
    ],
    statements: (db, guard) => [
      updateSeriesStatement(db, series, { title }, now),
      ...open.flatMap((t) => [
        updateTaskStatement(db, user.id, t.id, t.version, { title }, now, guard),
        projectTaskStatement(db, deps.ids, { ...t, title }, t.version + 1, now, guard),
      ]),
    ],
  };
}

/**
 * Stops the series: occurrences from today on are cancelled (and their markers
 * removed); earlier unfinished occurrences stay open.
 */
async function stopSeries(
  deps: SetupDeps,
  user: UserRecord,
  series: SeriesRecord,
): Promise<Reaction> {
  const now = deps.clock.now();
  const today = localDateAt(now, user.timezone);
  const cancel = (await openOccurrences(deps, user, series.id)).filter(
    (t) => (t.occurrenceDate ?? "") >= today,
  );
  return {
    replies: [
      {
        method: "sendMessage",
        params: {
          chat_id: user.privateChatId,
          text: `Stopped repeating ${series.title}. Cancelled ${cancel.length} upcoming occurrence${cancel.length === 1 ? "" : "s"}.`,
        },
      },
    ],
    statements: (db, guard) => [
      updateSeriesStatement(db, series, { status: "stopped" }, now),
      ...cancel.flatMap((t) => [
        updateTaskStatement(db, user.id, t.id, t.version, { status: "cancelled" }, now, guard),
        projectTaskStatement(db, deps.ids, t, t.version + 1, now, guard),
      ]),
    ],
  };
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
