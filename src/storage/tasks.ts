import type { EventFields } from "../domain/calendar-event";
import { type Deadline, normalizeListName, type TaskStatus } from "../domain/tasks";
import type { IdGenerator } from "../shared/ids";
import type { Guard } from "./guard";

export interface TaskList {
  id: string;
  name: string;
  isInbox: boolean;
  openCount: number;
}

export interface TaskRecord {
  id: string;
  userId: string;
  listId: string;
  listName: string;
  title: string;
  deadline: Deadline;
  status: TaskStatus;
  version: number;
  projection: { calendarId: string; eventId: string; etag: string | null } | null;
  /** The marker last written to (or read from) the task calendar. */
  projected: EventFields | null;
  /** The next reminder is moved to this instant; the deadline is unchanged. */
  snoozedUntil: number | null;
  /** For occurrences of a recurring task: the series and the occurrence's identity. */
  seriesId: string | null;
  occurrenceDate: string | null;
}

interface TaskRow {
  id: string;
  user_id: string;
  list_id: string;
  list_name: string;
  title: string;
  due_kind: "none" | "date" | "datetime";
  due_date: string | null;
  due_at: number | null;
  due_tz: string | null;
  status: TaskStatus;
  version: number;
  projection_calendar_id: string | null;
  projection_event_id: string | null;
  projection_etag: string | null;
  projected_json: string | null;
  snoozed_until: number | null;
  series_id: string | null;
  occurrence_date: string | null;
}

const TASK_COLUMNS = `t.id, t.user_id, t.list_id, l.name AS list_name, t.title, t.due_kind,
  t.due_date, t.due_at, t.due_tz, t.status, t.version, t.projection_calendar_id,
  t.projection_event_id, t.projection_etag, t.projected_json, t.snoozed_until, t.series_id, t.occurrence_date`;

const FROM = "FROM tasks t JOIN task_lists l ON l.id = t.list_id AND l.user_id = t.user_id";

function toTask(row: TaskRow): TaskRecord {
  const deadline: Deadline =
    row.due_kind === "date"
      ? { kind: "date", date: row.due_date ?? "" }
      : row.due_kind === "datetime"
        ? { kind: "datetime", at: row.due_at ?? 0, timeZone: row.due_tz ?? "UTC" }
        : { kind: "none" };
  return {
    id: row.id,
    userId: row.user_id,
    listId: row.list_id,
    listName: row.list_name,
    title: row.title,
    deadline,
    status: row.status,
    version: row.version,
    projection:
      row.projection_calendar_id && row.projection_event_id
        ? {
            calendarId: row.projection_calendar_id,
            eventId: row.projection_event_id,
            etag: row.projection_etag,
          }
        : null,
    projected: row.projected_json ? (JSON.parse(row.projected_json) as EventFields) : null,
    snoozedUntil: row.snoozed_until,
    seriesId: row.series_id,
    occurrenceDate: row.occurrence_date,
  };
}

function deadlineColumns(
  deadline: Deadline,
): [string, string | null, number | null, string | null] {
  switch (deadline.kind) {
    case "none":
      return ["none", null, null, null];
    case "date":
      return ["date", deadline.date, null, null];
    case "datetime":
      return ["datetime", null, deadline.at, deadline.timeZone];
  }
}

// --- Lists ------------------------------------------------------------------------

export const INBOX = "Inbox";

/** Every user has exactly one Inbox; creating it again is a no-op. */
export function ensureInboxStatement(
  db: D1Database,
  ids: IdGenerator,
  userId: string,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO task_lists (id, user_id, name, normalized_name, is_inbox, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?) ON CONFLICT DO NOTHING`,
    )
    .bind(ids.next(), userId, INBOX, normalizeListName(INBOX), now, now);
}

export async function listTaskLists(db: D1Database, userId: string): Promise<TaskList[]> {
  const { results } = await db
    .prepare(
      `SELECT l.id, l.name, l.is_inbox,
         (SELECT COUNT(*) FROM tasks t WHERE t.list_id = l.id AND t.user_id = l.user_id
            AND t.status = 'open') AS open_count
       FROM task_lists l WHERE l.user_id = ? ORDER BY l.is_inbox DESC, l.normalized_name`,
    )
    .bind(userId)
    .all<{ id: string; name: string; is_inbox: number; open_count: number }>();
  return results.map((r) => ({
    id: r.id,
    name: r.name,
    isInbox: r.is_inbox === 1,
    openCount: r.open_count,
  }));
}

export function insertListStatement(
  db: D1Database,
  id: string,
  userId: string,
  name: string,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO task_lists (id, user_id, name, normalized_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (user_id, normalized_name) DO NOTHING`,
    )
    .bind(id, userId, name.trim().replace(/\s+/g, " "), normalizeListName(name), now, now);
}

/**
 * Moves the list's tasks and recurring series to the Inbox (bumping task
 * versions), then deletes the list.
 */
export function deleteListStatements(
  db: D1Database,
  userId: string,
  listId: string,
  inboxId: string,
  now: number,
): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `UPDATE tasks SET list_id = ?, version = version + 1, updated_at = ?
         WHERE user_id = ? AND list_id = ?`,
      )
      .bind(inboxId, now, userId, listId),
    db
      .prepare(
        "UPDATE task_series SET list_id = ?, updated_at = ? WHERE user_id = ? AND list_id = ?",
      )
      .bind(inboxId, now, userId, listId),
    db
      .prepare("DELETE FROM task_lists WHERE id = ? AND user_id = ? AND is_inbox = 0")
      .bind(listId, userId),
  ];
}

// --- Tasks ------------------------------------------------------------------------

export interface NewTask {
  id: string;
  userId: string;
  listId: string;
  title: string;
  deadline: Deadline;
  status: TaskStatus;
  origin: "telegram" | "calendar";
  projection?: { calendarId: string; eventId: string; etag: string; fields: EventFields };
  occurrence?: { seriesId: string; date: string };
}

export function insertTaskStatement(
  db: D1Database,
  task: NewTask,
  now: number,
  guard: Guard,
): D1PreparedStatement {
  const [kind, date, at, tz] = deadlineColumns(task.deadline);
  return db
    .prepare(
      `INSERT INTO tasks (id, user_id, list_id, title, due_kind, due_date, due_at, due_tz, status,
         completed_at, cancelled_at, origin, projection_calendar_id, projection_event_id,
         projection_etag, projected_json, series_id, occurrence_date, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard.sql}
       ON CONFLICT DO NOTHING`,
    )
    .bind(
      task.id,
      task.userId,
      task.listId,
      task.title,
      kind,
      date,
      at,
      tz,
      task.status,
      task.status === "completed" ? now : null,
      task.status === "cancelled" ? now : null,
      task.origin,
      task.projection?.calendarId ?? null,
      task.projection?.eventId ?? null,
      task.projection?.etag ?? null,
      task.projection ? JSON.stringify(task.projection.fields) : null,
      task.occurrence?.seriesId ?? null,
      task.occurrence?.date ?? null,
      now,
      now,
      ...guard.params,
    );
}

export interface TaskChanges {
  title?: string;
  listId?: string;
  deadline?: Deadline;
  status?: TaskStatus;
}

/**
 * Applies changes only if the task is still at `expectedVersion`, and bumps the
 * version. Zero changed rows means someone else changed it first.
 */
export function updateTaskStatement(
  db: D1Database,
  userId: string,
  taskId: string,
  expectedVersion: number,
  changes: TaskChanges,
  now: number,
  guard: Guard,
): D1PreparedStatement {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (changes.title !== undefined) {
    sets.push("title = ?");
    values.push(changes.title);
  }
  if (changes.listId !== undefined) {
    sets.push("list_id = ?");
    values.push(changes.listId);
  }
  if (changes.deadline !== undefined) {
    const [kind, date, at, tz] = deadlineColumns(changes.deadline);
    sets.push("due_kind = ?", "due_date = ?", "due_at = ?", "due_tz = ?");
    values.push(kind, date, at, tz);
  }
  if (changes.status !== undefined) {
    sets.push(
      "status = ?",
      "completed_at = CASE WHEN ? = 'completed' THEN COALESCE(completed_at, ?) ELSE NULL END",
      "cancelled_at = CASE WHEN ? = 'cancelled' THEN COALESCE(cancelled_at, ?) ELSE NULL END",
    );
    values.push(changes.status, changes.status, now, changes.status, now);
  }
  return db
    .prepare(
      `UPDATE tasks SET ${[...sets, "version = version + 1", "updated_at = ?"].join(", ")}
       WHERE id = ? AND user_id = ? AND version = ? AND ${guard.sql}`,
    )
    .bind(...values, now, taskId, userId, expectedVersion, ...guard.params);
}

/** Records the marker as last written or read; does not change the task's version. */
export function setProjectionStatement(
  db: D1Database,
  userId: string,
  taskId: string,
  projection: { calendarId: string; eventId: string; etag: string; fields: EventFields } | null,
  now: number,
  guard: Guard,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE tasks SET projection_calendar_id = ?, projection_event_id = ?, projection_etag = ?,
         projected_json = ?, updated_at = ?
       WHERE id = ? AND user_id = ? AND ${guard.sql}`,
    )
    .bind(
      projection?.calendarId ?? null,
      projection?.eventId ?? null,
      projection?.etag ?? null,
      projection ? JSON.stringify(projection.fields) : null,
      now,
      taskId,
      userId,
      ...guard.params,
    );
}

export async function findTask(
  db: D1Database,
  userId: string,
  taskId: string,
): Promise<TaskRecord | null> {
  const row = await db
    .prepare(`SELECT ${TASK_COLUMNS} ${FROM} WHERE t.id = ? AND t.user_id = ?`)
    .bind(taskId, userId)
    .first<TaskRow>();
  return row ? toTask(row) : null;
}

/** Tasks linked to the given markers in one calendar. */
export async function findTasksByMarkers(
  db: D1Database,
  userId: string,
  calendarId: string,
  eventIds: readonly string[],
): Promise<TaskRecord[]> {
  if (eventIds.length === 0) return [];
  const placeholders = eventIds.map(() => "?").join(", ");
  const { results } = await db
    .prepare(
      `SELECT ${TASK_COLUMNS} ${FROM}
       WHERE t.user_id = ? AND t.projection_calendar_id = ? AND t.projection_event_id IN (${placeholders})`,
    )
    .bind(userId, calendarId, ...eventIds)
    .all<TaskRow>();
  return results.map(toTask);
}

/** Upper bound on open tasks loaded for a view; views paginate within it. */
export const MAX_OPEN_TASKS = 500;

/** A user's open tasks, optionally in one list (unordered; callers sort in the user's zone). */
export async function listOpenTasks(
  db: D1Database,
  userId: string,
  listId: string | null,
): Promise<TaskRecord[]> {
  const filter = listId ? "AND t.list_id = ?" : "";
  const params = listId ? [userId, listId] : [userId];
  const { results } = await db
    .prepare(
      `SELECT ${TASK_COLUMNS} ${FROM} WHERE t.user_id = ? AND t.status = 'open' ${filter}
       ORDER BY t.created_at LIMIT ${MAX_OPEN_TASKS}`,
    )
    .bind(...params)
    .all<TaskRow>();
  return results.map(toTask);
}

/** Moves the next reminder; never changes the deadline or the task's version. */
export function setSnoozeStatement(
  db: D1Database,
  userId: string,
  taskId: string,
  until: number | null,
  now: number,
): D1PreparedStatement {
  return db
    .prepare("UPDATE tasks SET snoozed_until = ?, updated_at = ? WHERE id = ? AND user_id = ?")
    .bind(until, now, taskId, userId);
}

/** Whether a task is currently snoozed (and so left out of automatic summaries). */
export function isSnoozed(task: Pick<TaskRecord, "snoozedUntil">, now: number): boolean {
  return task.snoozedUntil !== null && task.snoozedUntil > now;
}
