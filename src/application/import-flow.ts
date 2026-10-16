import type { TaskDue } from "../domain/capture";
import {
  type ExistingTask,
  type ImportTask,
  MAX_IMPORT,
  readImport,
  type SkipReason,
  taskKey,
} from "../domain/import";
import type { Deadline } from "../domain/tasks";
import { localDateAt, wallPartsAt } from "../domain/time";
import {
  clearPendingInputStatement,
  deleteUiActionsStatement,
  type PendingInput,
  type UiAction,
} from "../storage/interactions";
import {
  ensureInboxStatement,
  listOpenTasks,
  listTaskLists,
  type TaskRecord,
} from "../storage/tasks";
import type { UserRecord } from "../storage/users";
import type { InboundCallback, InboundMessage } from "../telegram/update";
import { guidedPrompt } from "./cancel";
import { toDeadline } from "./capture-flow";
import { ActionButtons, combine, message, type Reaction } from "./reactions";
import type { SetupDeps } from "./setup";
import { confirmPrompt, dueLabel, taskChangeStatements, taskCreation } from "./task-flow";
import { answer, keyboardMessage, removeButtons } from "./ui";

/**
 * /import: up to MAX_IMPORT tasks, one per line, read with the quick-capture
 * grammar, previewed, and created together after one confirmation. Lines that
 * aren't exactly one task are listed and skipped, never guessed at. The result
 * offers Undo import, which asks first and removes only unchanged tasks.
 */

const EXAMPLE = "Essay 2 by Fri 23 Oct 11:59pm to CS2040S\nQuiz 3 by Mon 26 Oct 9am\nBuy milk";
const SHOWN_SKIPS = 10;

export async function importCommand(
  deps: SetupDeps,
  user: UserRecord,
  input: InboundMessage,
): Promise<Reaction> {
  if (user.setupStep !== "done") {
    return message(user.privateChatId, "Finish setup first: send /start to continue.");
  }
  const text = (input.text ?? "").replace(/^\/import(@\w+)?/i, "");
  if (!text.trim()) {
    return guidedPrompt(
      deps,
      user,
      "import_list",
      {},
      `Send up to ${MAX_IMPORT} tasks, one per line, written as you would one at a time. Each "to <list>" must name a list you have.\n\n${EXAMPLE}`,
    );
  }
  return preview(deps, user, text);
}

export async function handleImportInput(
  deps: SetupDeps,
  user: UserRecord,
  input: InboundMessage,
  _pending: PendingInput,
): Promise<Reaction> {
  return combine(
    { replies: [], statements: (db) => [clearPendingInputStatement(db, user.id)] },
    await preview(deps, user, input.text ?? ""),
  );
}

/** A task as stored, in the terms the import compares by (the user's local day and time). */
function existingTask(task: TaskRecord, timeZone: string): ExistingTask {
  const d = task.deadline;
  let due: TaskDue = { kind: "none" };
  if (d.kind === "date") due = { kind: "date", date: d.date };
  if (d.kind === "datetime") {
    const w = wallPartsAt(d.at, timeZone);
    due = {
      kind: "datetime",
      date: localDateAt(d.at, timeZone),
      time: `${String(w.hour).padStart(2, "0")}:${String(w.minute).padStart(2, "0")}`,
    };
  }
  return { title: task.title, listId: task.listId, due };
}

async function preview(deps: SetupDeps, user: UserRecord, text: string): Promise<Reaction> {
  const now = deps.clock.now();
  await ensureInboxStatement(deps.db, deps.ids, user.id, now).run();
  const [lists, open] = await Promise.all([
    listTaskLists(deps.db, user.id),
    listOpenTasks(deps.db, user.id, null),
  ]);
  const result = readImport(
    text,
    {
      today: localDateAt(now, user.timezone),
      lists: lists.map((l) => ({ id: l.id, name: l.name })),
      inboxId: lists.find((l) => l.isInbox)?.id ?? null,
    },
    open.map((t) => existingTask(t, user.timezone)),
  );
  if (result.kind === "empty") {
    return message(user.privateChatId, `Nothing to import. Send /import with one task per line.`);
  }
  if (result.kind === "too_many") {
    return message(
      user.privateChatId,
      `That's ${result.count} tasks; one import adds up to ${MAX_IMPORT}. Send the first ${MAX_IMPORT} with /import, then the rest in another. Nothing was added.`,
    );
  }

  const names = new Map(lists.map((l) => [l.id, l.name]));
  const inbox = lists.find((l) => l.isInbox);
  const ready: { task: ImportTask; deadline: Deadline }[] = [];
  const skipped = [...result.skipped.map((s) => `• ${s.line}: ${reasonText(s.reason)}`)];
  for (const task of result.tasks) {
    const deadline = toDeadline(user, task.due);
    if (deadline.ok) ready.push({ task, deadline: deadline.deadline });
    else skipped.push(`• ${task.line}: ${deadline.text}`);
  }
  const notImported =
    skipped.length === 0
      ? ""
      : `\n\nNot imported (${skipped.length}):\n${skipped.slice(0, SHOWN_SKIPS).join("\n")}${
          skipped.length > SHOWN_SKIPS ? `\n…and ${skipped.length - SHOWN_SKIPS} more` : ""
        }`;
  if (ready.length === 0) {
    return message(user.privateChatId, `Nothing to import.${notImported}`);
  }

  const lines = ready.map(({ task, deadline }) => {
    const list = names.get(task.listId ?? "") ?? inbox?.name ?? "Inbox";
    const note = task.unknownList
      ? ` (no list named ${task.unknownList}, so it stays in the title)`
      : "";
    return `• ${task.title} · ${dueLabel(deadline, user.timezone)} · ${list}${note}`;
  });
  const count = plural(ready.length);
  const buttons = new ActionButtons(deps.ids, user.id, now, 10 * 60_000);
  const tasks = ready.map(({ task }) => ({
    title: task.title,
    listId: task.listId,
    due: task.due,
  }));
  const keyboard = [
    [buttons.button(`Import ${count}`, "import_confirm", { tasks })],
    [buttons.button("Cancel", "import_cancel", {})],
  ];
  // Each button carries its siblings, so the first press retires them all.
  buttons.annotate({ group: buttons.tokens() });
  return {
    replies: [
      keyboardMessage(
        user,
        `Import ${count}?\n${lines.join("\n")}${notImported}`,
        { inline_keyboard: keyboard },
        null,
      ),
    ],
    statements: (db, guard) => buttons.statements(db, guard),
  };
}

function reasonText(reason: SkipReason): string {
  switch (reason) {
    case "event":
      return 'a time without "by" reads as an event; put "by" before the date for a deadline.';
    case "ambiguous":
      return "the date or time could mean two things; write the date, like 23 Oct.";
    case "multiple":
      return "more than one date or time.";
    case "no_title":
      return "no title.";
    case "unclear":
      return "couldn't read it as a task.";
    case "repeated":
      return "same as an earlier line.";
    case "exists":
      return "already in your tasks.";
  }
}

function plural(n: number): string {
  return `${n} task${n === 1 ? "" : "s"}`;
}

// --- Buttons -----------------------------------------------------------------------

export function isImportAction(action: string): boolean {
  return action.startsWith("import_");
}

export async function handleImportAction(
  deps: SetupDeps,
  user: UserRecord,
  callback: InboundCallback,
  { action, payload }: UiAction,
): Promise<Reaction> {
  const ack = (text?: string) => answer(callback, text);
  const done = removeButtons(user, callback);
  const group = Array.isArray(payload.group) ? payload.group.map(String) : [];
  const retire: Reaction = {
    replies: [],
    statements: (db) => (group.length ? [deleteUiActionsStatement(db, user.id, group)] : []),
  };
  switch (action) {
    case "import_confirm":
      return combine(ack(), done, retire, await confirmImport(deps, user, payload));
    case "import_cancel":
      return combine(ack(), done, retire, message(user.privateChatId, "Nothing was imported."));
    case "import_undo": {
      const ids = taskIds(payload);
      return combine(
        ack(),
        done,
        confirmPrompt(
          deps,
          user,
          `Remove the ${plural(ids.length)} from this import? Any you've changed since stay.`,
          `Remove ${plural(ids.length)}`,
          "import_undo_confirm",
          { taskIds: ids },
        ),
      );
    }
    case "import_undo_confirm":
      return combine(ack(), done, await undoImport(deps, user, taskIds(payload)));
    default:
      return ack("This button is no longer valid.");
  }
}

function taskIds(payload: Record<string, unknown>): string[] {
  return Array.isArray(payload.taskIds) ? payload.taskIds.map(String) : [];
}

/**
 * Creates the previewed tasks together. The lists are checked again: if one
 * was deleted since the preview, nothing is created (the confirmation was for
 * those lists). A task added meanwhile is skipped rather than duplicated.
 */
async function confirmImport(
  deps: SetupDeps,
  user: UserRecord,
  payload: Record<string, unknown>,
): Promise<Reaction> {
  const drafts = (Array.isArray(payload.tasks) ? payload.tasks : []) as {
    title: string;
    listId: string | null;
    due: TaskDue;
  }[];
  if (drafts.length === 0 || drafts.length > MAX_IMPORT) {
    return message(user.privateChatId, "This import is no longer valid. Send /import again.");
  }
  const [lists, open] = await Promise.all([
    listTaskLists(deps.db, user.id),
    listOpenTasks(deps.db, user.id, null),
  ]);
  const inbox = lists.find((l) => l.isInbox);
  if (!inbox || drafts.some((d) => d.listId && !lists.some((l) => l.id === d.listId))) {
    return message(
      user.privateChatId,
      "A list in this import has changed since the preview, so nothing was added. Send /import again.",
    );
  }
  const known = new Set(
    open.map((t) => {
      const e = existingTask(t, user.timezone);
      return taskKey(e.title, e.listId, e.due);
    }),
  );
  const now = deps.clock.now();
  const created: { id: string; list: string }[] = [];
  const creations: Reaction[] = [];
  let existed = 0;
  for (const draft of drafts) {
    const list = lists.find((l) => l.id === draft.listId) ?? inbox;
    const deadline = toDeadline(user, draft.due);
    if (!deadline.ok) continue;
    if (known.has(taskKey(draft.title, list.id, draft.due))) {
      existed++;
      continue;
    }
    const creation = taskCreation(deps.ids, now, user, list, draft.title, deadline.deadline, {
      chat: false,
    });
    // An import has no single item for follow-ups like "move it" to refer to.
    const { about, ...quiet } = creation;
    if (about?.kind === "task") created.push({ id: about.taskId, list: list.name });
    creations.push(quiet);
  }
  if (created.length === 0) {
    return message(user.privateChatId, "Nothing was added: those tasks are already in your lists.");
  }
  const perList = new Map<string, number>();
  for (const c of created) perList.set(c.list, (perList.get(c.list) ?? 0) + 1);
  const where = [...perList].map(([list, n]) => `${n} to ${list}`).join(", ");
  const note = existed
    ? `\n${existed} already existed, so ${existed === 1 ? "it was" : "they were"} skipped.`
    : "";
  const buttons = new ActionButtons(deps.ids, user.id, now);
  const summary: Reaction = {
    replies: [
      keyboardMessage(
        user,
        `Imported ${plural(created.length)}: ${where}.${note}`,
        {
          inline_keyboard: [
            [buttons.button("Undo import", "import_undo", { taskIds: created.map((c) => c.id) })],
          ],
        },
        null,
      ),
    ],
    statements: (db, guard) => buttons.statements(db, guard),
  };
  return combine(
    { replies: [], statements: (db) => [clearPendingInputStatement(db, user.id)] },
    ...creations,
    summary,
  );
}

/** Removes the imported tasks that are still open and unchanged (version 1). */
async function undoImport(deps: SetupDeps, user: UserRecord, ids: string[]): Promise<Reaction> {
  const wanted = new Set(ids);
  const open = await listOpenTasks(deps.db, user.id, null);
  const unchanged = open.filter((t) => wanted.has(t.id) && t.version === 1);
  const kept = ids.length - unchanged.length;
  if (unchanged.length === 0) {
    return message(
      user.privateChatId,
      "Nothing was removed: those tasks have changed or are already gone.",
    );
  }
  const now = deps.clock.now();
  const note = kept ? ` ${kept} changed since, so ${kept === 1 ? "it stays" : "they stay"}.` : "";
  return {
    replies: [
      {
        method: "sendMessage",
        params: {
          chat_id: user.privateChatId,
          text: `Removed ${plural(unchanged.length)} from the import.${note}`,
        },
      },
    ],
    statements: (db, guard) =>
      unchanged.flatMap((task) =>
        taskChangeStatements(db, deps.ids, user, task, { status: "cancelled" }, now, guard),
      ),
  };
}
