import type { EventFields } from "../domain/calendar-event";
import { deadlineFromMarker, parseMarkerTitle } from "../domain/tasks";
import type { UiAction } from "../storage/interactions";
import { findOperation } from "../storage/operations";
import {
  findTask,
  listTaskLists,
  setProjectionStatement,
  type TaskChanges,
  updateTaskStatement,
} from "../storage/tasks";
import type { UserRecord } from "../storage/users";
import type { InboundCallback } from "../telegram/update";
import { guestChangePreview, PATCH_EVENT, type PatchEventIntent } from "./event-operations";
import { prepareProposal } from "./proposals";
import { combine, message, type Reaction } from "./reactions";
import type { SetupDeps } from "./setup";
import { projectTaskStatement } from "./task-projection";
import { answer, removeButtons } from "./ui";

/**
 * Same-field conflicts between a pending Telegram change and an edit made in
 * Google Calendar (spec §8): the user chooses which value to keep. Nothing is
 * overwritten until they do.
 */

export function isConflictAction(action: string): boolean {
  return action.startsWith("conflict_");
}

export async function handleConflictAction(
  deps: SetupDeps,
  user: UserRecord,
  callback: InboundCallback,
  { action, payload }: UiAction,
): Promise<Reaction> {
  const done = removeButtons(user, callback);
  const now = deps.clock.now();

  if (action === "conflict_theirs" || action === "conflict_mine") {
    const op = await findOperation(deps.db, user.id, String(payload.operationId ?? ""));
    if (op?.status !== "needs_resolution" || op.kind !== PATCH_EVENT) {
      return answer(callback, "This conflict has already been resolved.");
    }
    const cancel = deps.db
      .prepare(
        `UPDATE operations SET status = 'cancelled', error_class = 'conflict_resolved', updated_at = ?
         WHERE id = ? AND user_id = ? AND status = 'needs_resolution'`,
      )
      .bind(now, op.id, user.id);
    const intent = op.intent as PatchEventIntent;
    if (action === "conflict_theirs") {
      return combine(
        answer(callback),
        done,
        message(user.privateChatId, `Kept the Calendar version of ${intent.title}.`),
        {
          replies: [],
          statements: () => [cancel],
        },
      );
    }
    // Re-apply the change on top of what Calendar has now.
    const current = ((op.result as { current?: Partial<EventFields> } | null)?.current ??
      {}) as Partial<EventFields>;
    const next: PatchEventIntent = { ...intent, base: { ...intent.base, ...current } };
    const prepared = await prepareProposal(deps, user, {
      kind: PATCH_EVENT,
      idempotencyKey: `resolve:${op.id}`,
      intent: next,
      confirmation: next.notify ? guestChangePreview(next) : null,
    });
    return combine(answer(callback, "Keeping your change."), done, {
      replies: prepared.replies,
      statements: (db, guard) => [cancel, ...(prepared.statements?.(db, guard) ?? [])],
    });
  }

  // Task conflicts.
  const task = await findTask(deps.db, user.id, String(payload.taskId ?? ""));
  const marker = payload.marker as { etag: string; fields: EventFields } | undefined;
  if (!task || !marker || task.version !== Number(payload.version) || !task.projection) {
    return answer(callback, "This task has changed since. Open it from /tasks.");
  }
  const link = task.projection;
  const accept = setProjectionStatement(
    deps.db,
    user.id,
    task.id,
    {
      calendarId: link.calendarId,
      eventId: link.eventId,
      etag: marker.etag,
      fields: marker.fields,
    },
    now,
    { sql: "1", params: [] },
  );

  if (action === "conflict_task_mine") {
    // The Calendar values become the base, so the marker is rewritten with yours.
    return combine(answer(callback, "Keeping your change."), done, {
      replies: [],
      statements: (db, guard) => [
        accept,
        projectTaskStatement(db, deps.ids, task, task.version, now, guard),
      ],
    });
  }

  // Keep the Calendar version: adopt its values in the task.
  const lists = await listTaskLists(deps.db, user.id);
  const parsed = parseMarkerTitle(
    marker.fields.summary,
    lists.map((l) => l.name),
  );
  const changes: TaskChanges = {
    title: parsed.title,
    deadline: deadlineFromMarker(marker.fields.start),
    status: parsed.completed ? "completed" : task.status === "completed" ? "open" : task.status,
  };
  const list = lists.find((l) => l.name === parsed.listName);
  if (list) changes.listId = list.id;
  return combine(
    answer(callback),
    done,
    message(user.privateChatId, `Kept the Calendar version: ${parsed.title}.`),
    {
      replies: [],
      statements: (db, guard) => [
        accept,
        updateTaskStatement(db, user.id, task.id, task.version, changes, now, guard),
        projectTaskStatement(
          db,
          deps.ids,
          { ...task, title: parsed.title },
          task.version + 1,
          now,
          guard,
        ),
      ],
    },
  );
}
