import type { Clock } from "../shared/clock";
import type { IdGenerator } from "../shared/ids";
import {
  clearPendingInputStatement,
  findPendingInput,
  type PendingInputKind,
  setPendingInputStatement,
  type UiAction,
} from "../storage/interactions";
import type { UserRecord } from "../storage/users";
import type { InlineKeyboardButton } from "../telegram/api";
import type { InboundCallback } from "../telegram/update";
import { ActionButtons, combine, message, type Reaction } from "./reactions";
import { answer, keyboardMessage, removeButtons } from "./ui";

/**
 * A way out of guided questions: every question that waits for typed input
 * carries a Cancel button, and /cancel drops whatever is open. Cancelling only
 * forgets the unanswered question; nothing already done is changed.
 */

/** How long a guided question waits for typed input. */
export const PENDING_INPUT_TTL_MS = 10 * 60_000;

const CANCEL_ACTION = "input_cancel";

interface PromptDeps {
  clock: Clock;
  ids: IdGenerator;
}

/** A question that waits for typed input, with its buttons and a Cancel row. */
export function guidedPrompt(
  deps: PromptDeps,
  user: UserRecord,
  kind: PendingInputKind,
  payload: Record<string, unknown>,
  text: string,
  rows: InlineKeyboardButton[][] = [],
  buttons: ActionButtons = new ActionButtons(deps.ids, user.id, deps.clock.now()),
): Reaction {
  const now = deps.clock.now();
  const cancel = buttons.button("Cancel", CANCEL_ACTION, {
    kind,
    what: describePending(kind, payload),
  });
  return {
    replies: [keyboardMessage(user, text, { inline_keyboard: [...rows, [cancel]] }, null)],
    statements: (db, guard) => [
      setPendingInputStatement(db, user.id, kind, now + PENDING_INPUT_TTL_MS, now, payload),
      ...buttons.statements(db, guard),
    ],
  };
}

/** A Cancel row for a question answered only with buttons. */
export function cancelRow(buttons: ActionButtons, what: string): InlineKeyboardButton[] {
  return [buttons.button("Cancel", CANCEL_ACTION, { kind: null, what })];
}

/** What an open question was for, e.g. "adding the event Dinner". */
export function describePending(kind: PendingInputKind, payload: Record<string, unknown>): string {
  const draft = (payload.draft ?? {}) as { title?: unknown; move?: unknown; taskId?: unknown };
  const title = typeof draft.title === "string" ? draft.title : null;
  switch (kind) {
    case "new_default_calendar_name":
      return "creating a calendar";
    case "timezone":
      return "changing the timezone";
    case "event_title":
      return "adding an event";
    case "event_date":
    case "event_time":
    case "event_duration":
      if (!title) return "adding an event";
      return draft.move ? `moving ${title}` : `adding the event ${title}`;
    case "event_rename":
      return "renaming an event";
    case "task_title":
      return "adding a task";
    case "task_due_date":
    case "task_due_time":
      if (!title) return "adding a task";
      return draft.taskId ? `changing the deadline of ${title}` : `adding the task ${title}`;
    case "task_rename":
      return "renaming a task";
    case "list_name":
      return "creating a list";
    case "task_snooze":
      return "snoozing a task";
    case "series_rename":
      return "renaming a series";
    case "event_invite":
      return "inviting guests";
    case "event_contact_email":
      return "inviting guests";
    case "event_list_date":
      return "choosing an event";
    case "find_query":
      return "searching";
  }
}

export async function cancelCommand(
  deps: PromptDeps & { db: D1Database },
  user: UserRecord,
): Promise<Reaction> {
  const pending = await findPendingInput(deps.db, user.id, deps.clock.now());
  if (!pending) return message(user.privateChatId, "Nothing to cancel.");
  return combine(
    { replies: [], statements: (db) => [clearPendingInputStatement(db, user.id)] },
    message(user.privateChatId, `Cancelled ${describePending(pending.kind, pending.payload)}.`),
  );
}

export function isCancelAction(action: string): boolean {
  return action === CANCEL_ACTION;
}

export async function handleCancelAction(
  deps: PromptDeps & { db: D1Database },
  user: UserRecord,
  callback: InboundCallback,
  { payload }: UiAction,
): Promise<Reaction> {
  const what = typeof payload.what === "string" ? payload.what : "that";
  const kind = typeof payload.kind === "string" ? payload.kind : null;
  const done = combine(answer(callback), removeButtons(user, callback));
  if (kind) {
    // Only the question this button belongs to; a newer one stays open.
    const pending = await findPendingInput(deps.db, user.id, deps.clock.now());
    if (pending?.kind !== kind)
      return combine(
        answer(callback, "This question is already closed."),
        removeButtons(user, callback),
      );
    return combine(
      done,
      {
        replies: [],
        statements: (db) => [clearPendingInputStatement(db, user.id)],
      },
      message(user.privateChatId, `Cancelled ${what}.`),
    );
  }
  return combine(done, message(user.privateChatId, `Cancelled ${what}.`));
}
