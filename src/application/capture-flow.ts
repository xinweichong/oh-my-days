import type { EventFields } from "../domain/calendar-event";
import { type CaptureDraft, capture, type TaskDue } from "../domain/capture";
import type { DurationInput } from "../domain/parse-input";
import type { Deadline } from "../domain/tasks";
import { addDays, type LocalDate, localDateAt, type WallTime } from "../domain/time";
import { listStoredCalendars } from "../storage/google";
import { deleteUiActionsStatement, type UiAction } from "../storage/interactions";
import { findOperation } from "../storage/operations";
import { ensureInboxStatement, findTask, listTaskLists } from "../storage/tasks";
import type { UserRecord } from "../storage/users";
import type { InlineKeyboardButton } from "../telegram/api";
import { formatDayLabel, formatEventRange, formatWallTime } from "../telegram/format";
import type { InboundCallback, InboundMessage } from "../telegram/update";
import { whenLabel, whenQuestion } from "./choices";
import {
  askDate,
  create,
  DEFAULT_DURATION_MINUTES,
  type EventFlowDeps,
  eventCalendars,
  timedFields,
  unavailable,
} from "./event-flow";
import {
  CREATE_EVENT,
  type CreateEventIntent,
  DELETE_EVENT,
  type DeleteEventIntent,
  type TaskInstead,
} from "./event-operations";
import { prepareProposal } from "./proposals";
import { ActionButtons, combine, message, type Reaction } from "./reactions";
import { change, confirmPrompt, createTask, dueLabel, timedDeadline } from "./task-flow";
import { answer, keyboardMessage, removeButtons } from "./ui";

/**
 * Quick capture (spec §4): a plain message becomes one event or task through
 * the same operations as guided input, or a focused question. It only creates;
 * the result offers Undo and a switch between task and event.
 */

const LABEL_TITLE_LENGTH = 30;

/** An event to create in place of a removed task (date only: all day). */
interface EventInstead {
  title: string;
  date: LocalDate;
  time: WallTime | null;
}

export async function handleCapture(
  deps: EventFlowDeps,
  user: UserRecord,
  input: InboundMessage,
): Promise<Reaction> {
  const now = deps.clock.now();
  await ensureInboxStatement(deps.db, deps.ids, user.id, now).run();
  const [lists, calendars] = await Promise.all([
    listTaskLists(deps.db, user.id),
    listStoredCalendars(deps.db, user.id),
  ]);
  const today = localDateAt(now, user.timezone);
  const result = capture(input.text ?? "", {
    today,
    lists: lists.map((l) => ({ id: l.id, name: l.name })),
    calendars: eventCalendars(user, calendars).map((c) => ({ id: c.calendarId, name: c.summary })),
  });

  switch (result.kind) {
    case "create":
      return execute(deps, user, result.draft, `msg:${input.messageId}`);
    case "multiple":
      return message(
        user.privateChatId,
        "That's more than one request. Send each one as its own message; nothing was added.",
      );
    case "no_title":
      return message(user.privateChatId, "What is it called? Add a title, like Dinner Fri 7pm.");
    case "unclear":
      return offer(deps, user, "I couldn't read that as an event or a task.", (buttons) => [
        [
          buttons.button(`Add as task "${clip(result.title)}"`, "capture_task", {
            title: result.title,
          }),
        ],
        [buttons.button("Add as event", "capture_event", { title: result.title })],
      ]);
    case "choose":
      return offer(deps, user, question(result.options), (buttons) =>
        result.options.map((draft) => [
          buttons.button(optionLabel(draft, result.options, today), "capture_pick", { draft }),
        ]),
      );
  }
}

/** A question whose buttons act once; Cancel adds nothing. */
function offer(
  deps: EventFlowDeps,
  user: UserRecord,
  text: string,
  rows: (buttons: ActionButtons) => InlineKeyboardButton[][],
): Reaction {
  const buttons = new ActionButtons(deps.ids, user.id, deps.clock.now());
  const keyboard = [...rows(buttons), [buttons.button("Cancel", "capture_cancel", {})]];
  // Each button carries its siblings, so the first press retires them all.
  buttons.annotate({ group: buttons.tokens() });
  return {
    replies: [keyboardMessage(user, text, { inline_keyboard: keyboard }, null)],
    statements: (db, guard) => buttons.statements(db, guard),
  };
}

function question(options: CaptureDraft[]): string {
  const kinds = new Set(options.map((o) => o.kind));
  const first = options[0];
  if (kinds.size > 1) {
    const dates = new Set(options.map(dateOf));
    return dates.size === 1 && first
      ? `${first.title}: a task due that day, or an all-day event?`
      : "Which one?";
  }
  return whenQuestion(options.map(whenOf));
}

function dateOf(draft: CaptureDraft): LocalDate | null {
  if (draft.kind === "event") return draft.date;
  return draft.due.kind === "none" ? null : draft.due.date;
}

function whenOf(draft: CaptureDraft): { date: LocalDate | null; time: WallTime | null } {
  if (draft.kind === "event") return { date: draft.date, time: draft.start };
  if (draft.due.kind === "datetime") return { date: draft.due.date, time: draft.due.time };
  return { date: dateOf(draft), time: null };
}

function optionLabel(draft: CaptureDraft, options: CaptureDraft[], today: LocalDate): string {
  const mixed = new Set(options.map((o) => o.kind)).size > 1;
  const when = whenLabel(whenOf(draft), today);
  if (!mixed) return when;
  if (draft.kind === "task") return `Task due ${when}`;
  return draft.start ? `Event ${when}` : `All-day event ${when}`;
}

function clip(text: string): string {
  return text.length <= LABEL_TITLE_LENGTH ? text : `${text.slice(0, LABEL_TITLE_LENGTH - 1)}…`;
}

// --- Creating ---------------------------------------------------------------------

async function execute(
  deps: EventFlowDeps,
  user: UserRecord,
  draft: CaptureDraft,
  key: string,
): Promise<Reaction> {
  if (draft.kind === "task") {
    const deadline = toDeadline(user, draft.due);
    if (!deadline.ok) return message(user.privateChatId, deadline.text);
    const instead: EventInstead | null =
      draft.due.kind === "none"
        ? null
        : {
            title: draft.title,
            date: draft.due.date,
            time: draft.due.kind === "datetime" ? draft.due.time : null,
          };
    return createTask(
      deps,
      user,
      { title: draft.title, ...(draft.listId ? { listId: draft.listId } : {}) },
      deadline.deadline,
      {
        rows: (buttons, taskId) => [
          [buttons.button("Make it an event", "capture_to_event", { taskId, version: 1, instead })],
        ],
      },
    );
  }

  const blocked = await unavailable(deps, user);
  if (blocked) return blocked;
  const fields = eventFields(user, draft.title, draft.date, draft.start, draft.length);
  if (!fields.ok) return message(user.privateChatId, fields.text);
  const due = toDeadline(
    user,
    draft.start
      ? { kind: "datetime", date: draft.date, time: draft.start }
      : { kind: "date", date: draft.date },
  );
  const switchTo: TaskInstead | undefined = due.ok
    ? { title: draft.title, deadline: due.deadline, listId: null }
    : undefined;
  return create(deps, user, fields.fields, key, null, {
    calendarId: draft.calendarId,
    ...(switchTo ? { switchTo } : {}),
  });
}

function toDeadline(
  user: UserRecord,
  due: TaskDue,
): { ok: true; deadline: Deadline } | { ok: false; text: string } {
  switch (due.kind) {
    case "none":
      return { ok: true, deadline: { kind: "none" } };
    case "date":
      return { ok: true, deadline: { kind: "date", date: due.date } };
    case "datetime":
      return timedDeadline(user, due.date, due.time);
  }
}

function eventFields(
  user: UserRecord,
  title: string,
  date: LocalDate,
  start: WallTime | null,
  length: DurationInput | null,
): { ok: true; fields: EventFields } | { ok: false; text: string } {
  if (!start) {
    return {
      ok: true,
      fields: { summary: title, start: { date }, end: { date: addDays(date, 1) } },
    };
  }
  const timed = timedFields(
    user,
    { title, date, time: start },
    length ?? { minutes: DEFAULT_DURATION_MINUTES },
  );
  if (!timed.ok) return timed;
  return { ok: true, fields: { summary: title, start: timed.start, end: timed.end } };
}

// --- Buttons -----------------------------------------------------------------------

export function isCaptureAction(action: string): boolean {
  return action.startsWith("capture_");
}

export async function handleCaptureAction(
  deps: EventFlowDeps,
  user: UserRecord,
  callback: InboundCallback,
  { action, payload }: UiAction,
): Promise<Reaction> {
  const key = `ui:${callback.data}`;
  const ack = (text?: string) => answer(callback, text);
  const done = removeButtons(user, callback);
  const group = Array.isArray(payload.group) ? payload.group.map(String) : [];
  const retire: Reaction = {
    replies: [],
    statements: (db) => (group.length ? [deleteUiActionsStatement(db, user.id, group)] : []),
  };
  const title = typeof payload.title === "string" ? payload.title : "";

  switch (action) {
    case "capture_pick": {
      const draft = payload.draft as CaptureDraft | undefined;
      if (!draft) return ack("This button is no longer valid.");
      return combine(ack(), done, retire, await execute(deps, user, draft, key));
    }
    case "capture_task":
      return combine(
        ack(),
        done,
        retire,
        await execute(
          deps,
          user,
          { kind: "task", title, due: { kind: "none" }, listId: null },
          key,
        ),
      );
    case "capture_event": {
      const blocked = await unavailable(deps, user);
      if (blocked) return combine(ack(), blocked);
      return combine(ack(), done, retire, askDate(deps, user, { title }));
    }
    case "capture_cancel":
      return combine(ack(), done, retire, message(user.privateChatId, "Nothing was added."));
    case "capture_to_task":
      return combine(
        ack(),
        await proposeTaskInstead(deps, user, String(payload.operationId ?? "")),
      );
    case "capture_to_event":
    case "capture_to_event_confirm":
      return combine(
        ack(),
        await eventInstead(deps, user, callback, payload, action === "capture_to_event_confirm"),
      );
    default:
      return ack("This button is no longer valid.");
  }
}

/**
 * "Make it a task" on a just-created event: removes the event (bound to the
 * created version, confirmed like any removal), then adds the task.
 */
async function proposeTaskInstead(
  deps: EventFlowDeps,
  user: UserRecord,
  operationId: string,
): Promise<Reaction> {
  const op = await findOperation(deps.db, user.id, operationId);
  const intent = op?.intent as CreateEventIntent | undefined;
  const created = op?.result as { fields: EventFields } | null | undefined;
  if (op?.kind !== CREATE_EVENT || op.status !== "succeeded" || !intent?.switchTo || !created) {
    return message(user.privateChatId, "This event can't be switched anymore.");
  }
  const blocked = await unavailable(deps, user);
  if (blocked) return blocked;
  const removal: DeleteEventIntent = {
    calendarId: intent.calendarId,
    eventId: intent.eventId,
    base: created.fields,
    undo: true,
    replacedBy: intent.switchTo,
  };
  const prepared = await prepareProposal(deps, user, {
    kind: DELETE_EVENT,
    idempotencyKey: `switch:${op.id}`,
    intent: removal,
    confirmation: {
      text: `Make ${created.fields.summary} a task instead?\nThis removes the event (${formatEventRange(created.fields, user.timezone)}) and adds a task: ${dueLabel(intent.switchTo.deadline, user.timezone)}.`,
      confirmLabel: "Make it a task",
      facts: { calendarId: removal.calendarId, eventId: removal.eventId, base: removal.base },
    },
  });
  return { replies: prepared.replies, statements: prepared.statements };
}

/**
 * "Make it an event" on a just-created task: asks first, then cancels the task
 * (only if unchanged since it was added) and creates the event.
 */
async function eventInstead(
  deps: EventFlowDeps,
  user: UserRecord,
  callback: InboundCallback,
  payload: Record<string, unknown>,
  confirmed: boolean,
): Promise<Reaction> {
  const taskId = String(payload.taskId ?? "");
  const version = Number(payload.version);
  const instead = (payload.instead ?? null) as EventInstead | null;
  const task = await findTask(deps.db, user.id, taskId);
  if (task?.status !== "open" || task.version !== version) {
    return message(user.privateChatId, "This task has changed since, so it stays a task.");
  }
  const blocked = await unavailable(deps, user);
  if (blocked) return blocked;
  const when = instead
    ? instead.time
      ? `${formatDayLabel(instead.date)}, ${formatWallTime(instead.time)}`
      : `${formatDayLabel(instead.date)} (all day)`
    : null;
  if (!confirmed) {
    return confirmPrompt(
      deps,
      user,
      `Make ${task.title} an event instead?\nThis removes the task${when ? ` and adds an event on ${when}` : ""}.`,
      "Make it an event",
      "capture_to_event_confirm",
      { taskId, version, instead },
    );
  }
  const removed = change(
    deps,
    user,
    task,
    { status: "cancelled" },
    { status: "open" },
    `Removed task: ${task.title}.`,
    null,
  );
  if (!instead) {
    // No date to place it on: continue as a guided event.
    return combine(
      removeButtons(user, callback),
      removed,
      askDate(deps, user, { title: task.title }),
    );
  }
  const fields = eventFields(user, instead.title, instead.date, instead.time, null);
  if (!fields.ok) return message(user.privateChatId, fields.text);
  return combine(
    removeButtons(user, callback),
    removed,
    await create(deps, user, fields.fields, `ui:${callback.data}`),
  );
}
