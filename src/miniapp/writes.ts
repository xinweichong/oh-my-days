import { eventFields, toDeadline } from "../application/capture-flow";
import { whenQuestion } from "../application/choices";
import { create, eventCalendars, unavailable } from "../application/event-flow";
import {
  openOccurrences,
  renameSeries,
  stopSeries,
  taskChangeStatements,
  taskCreation,
} from "../application/task-flow";
import { type CaptureDraft, capture } from "../domain/capture";
import { canonicalJson } from "../domain/field-merge";
import { MAX_TASK_TITLE } from "../domain/tasks";
import { addDays, isValidLocalDate, localDateAt, zonedInstant } from "../domain/time";
import { sha256Hex } from "../shared/hash";
import { logEvent } from "../shared/log";
import { findAppRequest, recordAppRequestStatement } from "../storage/app-requests";
import { listStoredCalendars } from "../storage/google";
import { findSeries } from "../storage/series";
import {
  ensureInboxStatement,
  findTask,
  listTaskLists,
  snoozeIfUnchangedStatement,
  type TaskChanges,
  type TaskRecord,
} from "../storage/tasks";
import type { UserRecord } from "../storage/users";
import { formatDayLabel, formatWallTime } from "../telegram/format";
import { apiError, json, type MiniAppDeps } from "./api";
import { pendingTaskIds, toAppTask } from "./views";

/**
 * Mini App writes (ADR 0005). Each maps to the chat's task operation: the same
 * D1 statements and deadline projection. Every write carries the task's
 * version (a mismatch is 409 with the current task) and a client key: a
 * replayed key changes nothing and returns the current state.
 */

const MAX_BODY = 16_384;
const KEY = /^[A-Za-z0-9_-]{8,64}$/;
const WALL = /^([01]\d|2[0-3]):[0-5]\d$/;

type Body = Record<string, unknown>;

async function readBody(request: Request): Promise<Body | null> {
  const text = await request.text();
  if (text.length > MAX_BODY) return null;
  try {
    const parsed: unknown = JSON.parse(text || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Body) : null;
  } catch {
    return null;
  }
}

export async function handleWrite(
  request: Request,
  path: string,
  user: UserRecord,
  deps: MiniAppDeps,
): Promise<Response> {
  const body = await readBody(request);
  if (!body) return apiError("bad_request", 400);
  const key = typeof body.key === "string" && KEY.test(body.key) ? body.key : null;

  if (path === "tasks") {
    if (!key) return apiError("bad_request", 400);
    return quickAdd(deps, user, body, key);
  }
  let m = /^tasks\/([A-Za-z0-9_-]{1,64})\/([a-z-]+)$/.exec(path);
  if (m?.[1] && m[2]) return taskAction(deps, user, m[1], m[2], body, key);
  m = /^series\/([A-Za-z0-9_-]{1,64})\/([a-z-]+)$/.exec(path);
  if (m?.[1] && m[2]) return seriesAction(deps, user, m[1], m[2], body, key);
  return apiError("not_found", 404);
}

async function appTask(deps: MiniAppDeps, user: UserRecord, taskId: string) {
  const task = await findTask(deps.db, user.id, taskId);
  if (!task) return null;
  return toAppTask(task, user, deps.clock.now(), await pendingTaskIds(deps.db, user.id));
}

async function stale(deps: MiniAppDeps, user: UserRecord, taskId: string): Promise<Response> {
  return json({ error: "stale", task: await appTask(deps, user, taskId) }, 409);
}

/** Runs a batch whose last statement records the key; a reused key replays instead. */
async function commit(
  deps: MiniAppDeps,
  statements: D1PreparedStatement[],
): Promise<D1Result[] | "replayed"> {
  try {
    return await deps.db.batch(statements);
  } catch (error) {
    // The key's primary key conflicts: a concurrent request with it won.
    if (error instanceof Error && /UNIQUE constraint failed: app_requests/.test(error.message)) {
      return "replayed";
    }
    throw error;
  }
}

/** The hash binding a confirmation to exactly what was previewed. */
async function previewHash(value: unknown): Promise<string> {
  return sha256Hex(canonicalJson(value));
}

// --- One task ---------------------------------------------------------------------

async function taskAction(
  deps: MiniAppDeps,
  user: UserRecord,
  taskId: string,
  action: string,
  body: Body,
  key: string | null,
): Promise<Response> {
  const task = await findTask(deps.db, user.id, taskId);
  if (!task) return apiError("not_found", 404);

  if (action === "cancel-preview") {
    if (body.version !== task.version) return stale(deps, user, taskId);
    if (task.status !== "open") return apiError("not_open", 409);
    const marker =
      task.deadline.kind === "none" ? "" : " Its deadline is removed from Google Calendar.";
    return json({
      text: `Cancel task: ${task.title}?${marker}`,
      confirmLabel: "Cancel task",
      previewHash: await previewHash({ action: "cancel", items: [[task.id, task.version]] }),
    });
  }

  if (!key) return apiError("bad_request", 400);
  if (await findAppRequest(deps.db, user.id, key)) {
    return json({ task: await appTask(deps, user, taskId), replayed: true });
  }
  if (body.version !== task.version) return stale(deps, user, taskId);

  const now = deps.clock.now();
  if (action === "snooze") return snooze(deps, user, task, body, key, now);

  const changes = await changesFor(deps, user, task, action, body);
  if ("error" in changes) return apiError(changes.error, changes.status);
  if (action === "cancel") {
    const expected = await previewHash({ action: "cancel", items: [[task.id, task.version]] });
    if (body.previewHash !== expected) return stale(deps, user, taskId);
  }

  const results = await commit(deps, [
    ...taskChangeStatements(deps.db, deps.ids, user, task, changes.changes, now, {
      sql: "1",
      params: [],
    }),
    recordAppRequestStatement(deps.db, user.id, key, { taskId }, now, {
      sql: "EXISTS (SELECT 1 FROM tasks WHERE id = ? AND user_id = ? AND version = ?)",
      params: [task.id, user.id, task.version + 1],
    }),
  ]);
  if (results === "replayed") {
    return json({ task: await appTask(deps, user, taskId), replayed: true });
  }
  // D1 counts trigger rows too (ADR 0004): zero means the version moved.
  if ((results[0]?.meta.changes ?? 0) === 0) return stale(deps, user, taskId);
  logEvent("miniapp.task_write", { action });
  return json({ task: await appTask(deps, user, taskId) });
}

async function changesFor(
  deps: MiniAppDeps,
  user: UserRecord,
  task: TaskRecord,
  action: string,
  body: Body,
): Promise<{ changes: TaskChanges } | { error: string; status: number }> {
  const open = task.status === "open";
  switch (action) {
    case "complete":
      return open ? { changes: { status: "completed" } } : { error: "not_open", status: 409 };
    case "reopen":
      return open ? { error: "already_open", status: 409 } : { changes: { status: "open" } };
    case "cancel":
      return open ? { changes: { status: "cancelled" } } : { error: "not_open", status: 409 };
    case "rename": {
      const title = typeof body.title === "string" ? body.title.trim() : "";
      if (!title || title.length > MAX_TASK_TITLE) return { error: "bad_title", status: 400 };
      return open ? { changes: { title } } : { error: "not_open", status: 409 };
    }
    case "move": {
      const lists = await listTaskLists(deps.db, user.id);
      const list = lists.find((l) => l.id === body.listId);
      if (!list) return { error: "bad_list", status: 400 };
      return { changes: { listId: list.id } };
    }
    case "deadline": {
      if (!open) return { error: "not_open", status: 409 };
      const d = body.deadline as { kind?: unknown; date?: unknown; time?: unknown } | undefined;
      if (d?.kind === "none") return { changes: { deadline: { kind: "none" } } };
      if (typeof d?.date !== "string" || !isValidLocalDate(d.date)) {
        return { error: "bad_deadline", status: 400 };
      }
      if (d.kind === "date") return { changes: { deadline: { kind: "date", date: d.date } } };
      if (d.kind === "datetime" && typeof d.time === "string" && WALL.test(d.time)) {
        const at = zonedInstant(d.date, d.time, user.timezone);
        if (!at.ok) return { error: "time_skipped", status: 400 };
        return {
          changes: { deadline: { kind: "datetime", at: at.instant, timeZone: user.timezone } },
        };
      }
      return { error: "bad_deadline", status: 400 };
    }
    default:
      return { error: "not_found", status: 404 };
  }
}

/** Moves only the next reminder; never the deadline or the task's version. */
async function snooze(
  deps: MiniAppDeps,
  user: UserRecord,
  task: TaskRecord,
  body: Body,
  key: string,
  now: number,
): Promise<Response> {
  if (task.status !== "open") return apiError("not_open", 409);
  const until = snoozeUntil(user, body, now);
  if (until === null) return apiError("bad_snooze", 400);
  const results = await commit(deps, [
    snoozeIfUnchangedStatement(deps.db, user.id, task.id, task.version, until, now),
    recordAppRequestStatement(deps.db, user.id, key, { taskId: task.id }, now, {
      sql: "EXISTS (SELECT 1 FROM tasks WHERE id = ? AND user_id = ? AND version = ? AND snoozed_until = ?)",
      params: [task.id, user.id, task.version, until],
    }),
  ]);
  if (results === "replayed") {
    return json({ task: await appTask(deps, user, task.id), replayed: true });
  }
  if ((results[0]?.meta.changes ?? 0) === 0) return stale(deps, user, task.id);
  return json({ task: await appTask(deps, user, task.id) });
}

/** "hour", "tomorrow" (at the agenda hour), or a local date and time. */
export function snoozeUntil(user: UserRecord, body: Body, now: number): number | null {
  if (body.preset === "hour") return now + 60 * 60_000;
  const date =
    body.preset === "tomorrow"
      ? addDays(localDateAt(now, user.timezone), 1)
      : typeof body.date === "string" && isValidLocalDate(body.date)
        ? body.date
        : null;
  const time =
    body.preset === "tomorrow"
      ? `${String(user.agendaHour).padStart(2, "0")}:00`
      : typeof body.time === "string" && WALL.test(body.time)
        ? body.time
        : null;
  if (!date || !time) return null;
  const at = zonedInstant(date, time, user.timezone);
  return at.ok && at.instant > now ? at.instant : null;
}

// --- Quick add ----------------------------------------------------------------------

async function quickAdd(
  deps: MiniAppDeps,
  user: UserRecord,
  body: Body,
  key: string,
): Promise<Response> {
  const previous = await findAppRequest(deps.db, user.id, key);
  if (previous) return json({ ...(await addedResponse(deps, user, previous)), replayed: true });

  const now = deps.clock.now();
  await ensureInboxStatement(deps.db, deps.ids, user.id, now).run();
  const [lists, stored] = await Promise.all([
    listTaskLists(deps.db, user.id),
    listStoredCalendars(deps.db, user.id),
  ]);
  const calendars = eventCalendars(user, stored);
  const defaultList =
    typeof body.listId === "string" ? lists.find((l) => l.id === body.listId) : undefined;

  let draft: CaptureDraft;
  if (body.draft !== undefined) {
    const valid = validDraft(body.draft, lists, calendars);
    if (!valid) return apiError("bad_request", 400);
    draft = valid;
  } else {
    const text = typeof body.text === "string" ? body.text : "";
    if (!text.trim()) return apiError("bad_request", 400);
    const today = localDateAt(now, user.timezone);
    const result = capture(text, {
      today,
      lists: lists.map((l) => ({ id: l.id, name: l.name })),
      calendars: calendars.map((c) => ({ id: c.calendarId, name: c.summary })),
    });
    switch (result.kind) {
      case "multiple":
        return json({
          kind: "multiple",
          message: "That's more than one request. Add each one separately.",
        });
      case "no_title":
        return json({ kind: "no_title", message: "Add a title, like Dinner Fri 7pm." });
      case "unclear":
        return json({
          kind: "unclear",
          message: "I couldn't read that as an event or a task.",
          options: [
            {
              label: `Add as task "${result.title.slice(0, 30)}"`,
              draft: { kind: "task", title: result.title, due: { kind: "none" }, listId: null },
            },
          ],
        });
      case "choose":
        return json({
          kind: "choose",
          message: chooseQuestion(result.options),
          options: result.options.map((o) => ({ label: draftLabel(o, today), draft: o })),
        });
      case "create":
        draft = result.draft;
    }
  }

  if (draft.kind === "task") {
    const deadline = toDeadline(user, draft.due);
    if (!deadline.ok) return json({ kind: "error", message: deadline.text }, 400);
    const list =
      lists.find((l) => l.id === draft.listId) ?? defaultList ?? lists.find((l) => l.isInbox);
    if (!list) return apiError("no_list", 409);
    const created = taskCreation(deps.ids, now, user, list, draft.title, deadline.deadline, {
      chat: false,
    });
    const taskId = created.about?.kind === "task" ? created.about.taskId : null;
    if (!taskId) return apiError("error", 500);
    const results = await commit(deps, [
      ...(created.statements?.(deps.db, { sql: "1", params: [] }) ?? []),
      recordAppRequestStatement(deps.db, user.id, key, { kind: "task", taskId }, now),
    ]);
    if (results === "replayed") {
      const stored = await findAppRequest(deps.db, user.id, key);
      return json({ ...(await addedResponse(deps, user, stored ?? {})), replayed: true });
    }
    return json(await addedResponse(deps, user, { kind: "task", taskId }));
  }

  // An event goes through the same create operation as chat; its result also appears there.
  const blocked = await unavailable(deps, user);
  if (blocked) return apiError("reconnect", 409);
  const fields = eventFields(user, draft.title, draft.date, draft.start, draft.length);
  if (!fields.ok) return json({ kind: "error", message: fields.text }, 400);
  const created = await create(deps, user, fields.fields, `app:${key}`, null, {
    calendarId: draft.calendarId,
  });
  if (!created.statements) return apiError("calendar_unavailable", 409);
  const summary = {
    kind: "event",
    title: draft.title,
    when: draft.start
      ? `${formatDayLabel(draft.date)}, ${formatWallTime(draft.start)}`
      : `${formatDayLabel(draft.date)} (all day)`,
  };
  const results = await commit(deps, [
    ...created.statements(deps.db, { sql: "1", params: [] }),
    recordAppRequestStatement(deps.db, user.id, key, summary, now),
  ]);
  return json({
    ...(await addedResponse(deps, user, summary)),
    ...(results === "replayed" ? { replayed: true } : {}),
  });
}

async function addedResponse(deps: MiniAppDeps, user: UserRecord, stored: Record<string, unknown>) {
  if (stored.kind === "task" && typeof stored.taskId === "string") {
    return { kind: "task", task: await appTask(deps, user, stored.taskId) };
  }
  return {
    kind: "event",
    title: stored.title,
    when: stored.when,
    message: "Adding to Google Calendar. The result will also appear in the chat.",
  };
}

function chooseQuestion(options: CaptureDraft[]): string {
  if (new Set(options.map((o) => o.kind)).size > 1)
    return "A task due that day, or an all-day event?";
  return whenQuestion(
    options.map((o) =>
      o.kind === "event"
        ? { date: o.date, time: o.start }
        : {
            date: o.due.kind === "none" ? null : o.due.date,
            time: o.due.kind === "datetime" ? o.due.time : null,
          },
    ),
  );
}

function draftLabel(draft: CaptureDraft, today: string): string {
  const day = (date: string) =>
    date === today ? `Today · ${formatDayLabel(date)}` : formatDayLabel(date);
  if (draft.kind === "event") {
    return draft.start
      ? `Event ${day(draft.date)}, ${formatWallTime(draft.start)}`
      : `All-day event ${day(draft.date)}`;
  }
  if (draft.due.kind === "none") return "Task, no deadline";
  return draft.due.kind === "datetime"
    ? `Task due ${day(draft.due.date)}, ${formatWallTime(draft.due.time)}`
    : `Task due ${day(draft.due.date)}`;
}

/** A capture draft sent back by the client: every reference is checked against this user. */
export function validDraft(
  value: unknown,
  lists: { id: string }[],
  calendars: { calendarId: string }[],
): CaptureDraft | null {
  if (!value || typeof value !== "object") return null;
  const d = value as Record<string, unknown>;
  const title = typeof d.title === "string" ? d.title.trim() : "";
  if (!title || title.length > MAX_TASK_TITLE) return null;
  if (d.kind === "task") {
    const listId = d.listId === null || d.listId === undefined ? null : String(d.listId);
    if (listId !== null && !lists.some((l) => l.id === listId)) return null;
    const due = d.due as Record<string, unknown> | undefined;
    if (due?.kind === "none") return { kind: "task", title, due: { kind: "none" }, listId };
    if (typeof due?.date !== "string" || !isValidLocalDate(due.date)) return null;
    if (due.kind === "date")
      return { kind: "task", title, due: { kind: "date", date: due.date }, listId };
    if (due.kind === "datetime" && typeof due.time === "string" && WALL.test(due.time)) {
      return {
        kind: "task",
        title,
        due: { kind: "datetime", date: due.date, time: due.time },
        listId,
      };
    }
    return null;
  }
  if (d.kind === "event") {
    if (typeof d.date !== "string" || !isValidLocalDate(d.date)) return null;
    const start =
      d.start === null
        ? null
        : typeof d.start === "string" && WALL.test(d.start)
          ? d.start
          : undefined;
    if (start === undefined) return null;
    const calendarId =
      d.calendarId === null || d.calendarId === undefined ? null : String(d.calendarId);
    if (calendarId !== null && !calendars.some((c) => c.calendarId === calendarId)) return null;
    const raw = d.length as Record<string, unknown> | null | undefined;
    let length: { minutes: number } | { endTime: string } | null = null;
    if (raw && typeof raw.minutes === "number" && raw.minutes > 0 && raw.minutes <= 7 * 24 * 60) {
      length = { minutes: Math.round(raw.minutes) };
    } else if (raw && typeof raw.endTime === "string" && WALL.test(raw.endTime)) {
      length = { endTime: raw.endTime };
    } else if (raw) {
      return null;
    }
    return { kind: "event", title, date: d.date, start, length, calendarId };
  }
  return null;
}

// --- Series ------------------------------------------------------------------------

async function seriesAction(
  deps: MiniAppDeps,
  user: UserRecord,
  seriesId: string,
  action: string,
  body: Body,
  key: string | null,
): Promise<Response> {
  const series = await findSeries(deps.db, user.id, seriesId);
  if (!series) return apiError("not_found", 404);
  if (series.status !== "active" || body.version !== series.version) {
    return json({ error: "stale" }, 409);
  }
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const isRename = action === "rename" || action === "rename-preview";
  if (isRename && (!title || title.length > MAX_TASK_TITLE)) return apiError("bad_title", 400);
  const bound = { action: isRename ? "rename" : "stop", seriesId, version: series.version, title };

  if (action === "rename-preview" || action === "stop-preview") {
    const open = await openOccurrences(deps, user, series.id);
    const text = isRename
      ? `Rename every open occurrence of ${series.title} to ${title}?`
      : `Stop repeating ${series.title}? Open occurrences from today on are cancelled (${open.length} open now).`;
    return json({
      text,
      confirmLabel: isRename ? "Rename series" : "Stop series",
      previewHash: await previewHash(bound),
    });
  }
  if (action !== "rename" && action !== "stop") return apiError("not_found", 404);
  if (!key) return apiError("bad_request", 400);
  if (await findAppRequest(deps.db, user.id, key)) return json({ ok: true, replayed: true });
  if (body.previewHash !== (await previewHash(bound))) return json({ error: "stale" }, 409);

  const now = deps.clock.now();
  const reaction = isRename
    ? await renameSeries(deps, user, series, title)
    : await stopSeries(deps, user, series);
  const results = await commit(deps, [
    ...(reaction.statements?.(deps.db, { sql: "1", params: [] }) ?? []),
    recordAppRequestStatement(deps.db, user.id, key, { seriesId }, now, {
      sql: "EXISTS (SELECT 1 FROM task_series WHERE id = ? AND user_id = ? AND version = ?)",
      params: [seriesId, user.id, series.version + 1],
    }),
  ]);
  if (results === "replayed") return json({ ok: true, replayed: true });
  if ((results[0]?.meta.changes ?? 0) === 0) return json({ error: "stale" }, 409);
  return json({ ok: true });
}
