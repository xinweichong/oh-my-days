import type { SyncedEvent } from "../calendar/port";
import type { EventFields } from "../domain/calendar-event";
import {
  type Deadline,
  deadlineFromMarker,
  deadlinesEqual,
  desiredMarker,
  markerTitle,
  parseMarkerTitle,
  type TaskStatus,
} from "../domain/tasks";
import type { IdGenerator } from "../shared/ids";
import type { Guard } from "../storage/guard";
import { enqueueStatement } from "../storage/outbox";
import {
  ensureInboxStatement,
  findTasksByMarkers,
  insertTaskStatement,
  listTaskLists,
  setProjectionStatement,
  type TaskChanges,
  type TaskList,
  type TaskRecord,
  updateTaskStatement,
} from "../storage/tasks";
import { findUserById, type UserRecord } from "../storage/users";
import { ActionButtons } from "./reactions";
import { projectTaskStatement } from "./task-projection";

export interface TaskSyncDeps {
  db: D1Database;
  ids: IdGenerator;
}

/**
 * Turns supported edits made to markers in the task calendar into task changes:
 * title, list annotation, ✓ completion, deadline, and deletion (cancellation).
 * Entries created directly in the task calendar become tasks. Echoes of the
 * bot's own writes are recognized by value. If a field changed both in
 * Calendar and in a not-yet-projected Telegram change, neither is overwritten
 * and the user is told.
 */
export async function reconcileTaskMarkers(
  deps: TaskSyncDeps,
  userId: string,
  calendarId: string,
  items: readonly SyncedEvent[],
  now: number,
  guard: Guard,
): Promise<D1PreparedStatement[]> {
  const user = await findUserById(deps.db, userId);
  if (!user || user.taskCalendarId !== calendarId || items.length === 0) return [];
  await ensureInboxStatement(deps.db, deps.ids, userId, now).run();
  const lists = await listTaskLists(deps.db, userId);
  const linked = new Map(
    (
      await findTasksByMarkers(
        deps.db,
        userId,
        calendarId,
        items.map((i) => i.id),
      )
    ).map((t) => [t.projection?.eventId, t]),
  );
  const statements: D1PreparedStatement[] = [];

  for (const item of items) {
    const task = linked.get(item.id);
    // Recurring markers belong to recurring tasks (a later stage).
    if (item.recurring || item.recurringEventId) continue;

    if (item.status === "cancelled" || !item.fields) {
      if (task) statements.push(...markerDeleted(deps, task, now, guard));
      continue;
    }
    if (!task) {
      statements.push(
        ...importMarker(deps, user, lists, calendarId, item, item.fields, now, guard),
      );
      continue;
    }
    if (task.projection?.etag === item.etag) continue; // our own write
    statements.push(...markerEdited(deps, user, lists, task, item, item.fields, now, guard));
  }
  return statements;
}

function markerDeleted(
  deps: TaskSyncDeps,
  task: TaskRecord,
  now: number,
  guard: Guard,
): D1PreparedStatement[] {
  const unlink = setProjectionStatement(deps.db, task.userId, task.id, null, now, guard);
  // The bot removed it (deadline removed or task cancelled), or it was completed:
  // just unlink. Otherwise the user deleted it in Calendar: cancel the task.
  if (task.status !== "open" || !desiredMarker(task)) return [unlink];
  return [
    updateTaskStatement(
      deps.db,
      task.userId,
      task.id,
      task.version,
      { status: "cancelled" },
      now,
      guard,
    ),
    unlink,
  ];
}

function importMarker(
  deps: TaskSyncDeps,
  user: UserRecord,
  lists: TaskList[],
  calendarId: string,
  item: SyncedEvent,
  fields: EventFields,
  now: number,
  guard: Guard,
): D1PreparedStatement[] {
  const parsed = parseMarkerTitle(
    fields.summary,
    lists.map((l) => l.name),
  );
  const list = lists.find((l) => l.name === parsed.listName) ?? lists.find((l) => l.isInbox);
  if (!list) return [];
  const id = deps.ids.next();
  return [
    insertTaskStatement(
      deps.db,
      {
        id,
        userId: user.id,
        listId: list.id,
        title: parsed.title,
        deadline: deadlineFromMarker(fields.start),
        status: parsed.completed ? "completed" : "open",
        origin: "calendar",
        projection: { calendarId, eventId: item.id, etag: item.etag, fields },
      },
      now,
      guard,
    ),
    // Rewrite the marker in the standard form (list annotation, marked free).
    projectTaskStatement(
      deps.db,
      deps.ids,
      { id, userId: user.id, title: parsed.title },
      1,
      now,
      guard,
    ),
  ];
}

interface MarkerState {
  title: string;
  listName: string;
  status: TaskStatus;
  deadline: Deadline;
}

function stateFromMarker(
  fields: EventFields,
  lists: TaskList[],
  fallbackList: string,
  fallbackStatus: TaskStatus,
): MarkerState {
  const parsed = parseMarkerTitle(
    fields.summary,
    lists.map((l) => l.name),
  );
  return {
    title: parsed.title,
    listName: parsed.listName ?? fallbackList,
    status: parsed.completed
      ? "completed"
      : fallbackStatus === "completed"
        ? "open"
        : fallbackStatus,
    deadline: deadlineFromMarker(fields.start),
  };
}

function markerEdited(
  deps: TaskSyncDeps,
  user: UserRecord,
  lists: TaskList[],
  task: TaskRecord,
  item: SyncedEvent,
  fields: EventFields,
  now: number,
  guard: Guard,
): D1PreparedStatement[] {
  const external = stateFromMarker(fields, lists, task.listName, task.status);
  const base = task.projected
    ? stateFromMarker(task.projected, lists, task.listName, task.status)
    : external;
  const local: MarkerState = {
    title: task.title,
    listName: task.listName,
    status: task.status,
    deadline: task.deadline,
  };

  const changes: TaskChanges = {};
  const conflicts: string[] = [];
  const consider = <K extends keyof MarkerState>(
    field: K,
    same: (a: MarkerState[K], b: MarkerState[K]) => boolean,
    apply: (value: MarkerState[K]) => void,
  ) => {
    const externalChanged = !same(external[field], base[field]);
    if (!externalChanged) return;
    const localChanged = !same(local[field], base[field]);
    if (localChanged && !same(local[field], external[field])) conflicts.push(field);
    else if (!same(local[field], external[field])) apply(external[field]);
  };
  consider(
    "title",
    (a, b) => a === b,
    (v) => {
      changes.title = v;
    },
  );
  consider(
    "listName",
    (a, b) => a === b,
    (v) => {
      const list = lists.find((l) => l.name === v);
      if (list) changes.listId = list.id;
    },
  );
  consider(
    "status",
    (a, b) => a === b,
    (v) => {
      changes.status = v;
    },
  );
  consider("deadline", deadlinesEqual, (v) => {
    changes.deadline = v;
  });

  const statements: D1PreparedStatement[] = [];
  const changed = Object.keys(changes).length > 0;
  if (changed) {
    statements.push(
      updateTaskStatement(deps.db, user.id, task.id, task.version, changes, now, guard),
    );
  }
  const link = task.projection;
  // While a conflict waits for the user, the last projected values stay the
  // base, so the pending Telegram change cannot overwrite the Calendar edit.
  if (link && conflicts.length === 0) {
    statements.push(
      setProjectionStatement(
        deps.db,
        user.id,
        task.id,
        { calendarId: link.calendarId, eventId: link.eventId, etag: item.etag, fields },
        now,
        guard,
      ),
    );
  }
  // Normalize the marker (e.g. restore a removed list annotation) unless a
  // conflict is waiting for the user.
  const normalized = markerTitle({
    title: changes.title ?? local.title,
    listName: changes.listId ? external.listName : local.listName,
    status: changes.status ?? local.status,
  });
  if (conflicts.length === 0 && normalized !== fields.summary) {
    statements.push(
      projectTaskStatement(deps.db, deps.ids, task, task.version + (changed ? 1 : 0), now, guard),
    );
  }
  if (conflicts.length > 0) {
    const buttons = new ActionButtons(deps.ids, user.id, now);
    const marker = { etag: item.etag, fields };
    const keyboard = {
      inline_keyboard: [
        [
          buttons.button("Keep Calendar version", "conflict_task_theirs", {
            taskId: task.id,
            version: task.version,
            marker,
          }),
          buttons.button("Use my change", "conflict_task_mine", {
            taskId: task.id,
            version: task.version,
            marker,
          }),
        ],
      ],
    };
    statements.push(
      ...buttons.statements(deps.db, guard),
      enqueueStatement(
        deps.db,
        deps.ids,
        user.id,
        {
          logicalKey: `task-conflict:${task.id}:${item.etag}`,
          about: { kind: "task", taskId: task.id },
          call: {
            method: "sendMessage",
            params: {
              chat_id: user.privateChatId,
              text: `${task.title} changed in Calendar to "${fields.summary}" while your change was pending. Nothing was overwritten. Which should I keep?`,
              reply_markup: keyboard,
            },
          },
        },
        now,
        guard,
      ),
    );
  }
  return statements;
}
