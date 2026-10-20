import {
  anchorLabel,
  checkRuleText,
  loadEventTarget,
  type ReminderTarget,
  reminderPanel,
  reminderState,
  taskTarget,
  typedReminders,
} from "../application/reminder-flow";
import { splitEventKey } from "../application/reminder-plan";
import { decodeRule, encodeRule, MAX_RULES, type ReminderRule } from "../domain/reminders";
import { findAppRequest, recordAppRequestStatement } from "../storage/app-requests";
import {
  clearRemindersStatement,
  reminderVersionGuard,
  setRemindersStatement,
} from "../storage/reminders";
import { findTask } from "../storage/tasks";
import type { UserRecord } from "../storage/users";
import { apiError, json, type MiniAppDeps } from "./api";

/**
 * Mini App reminders for one task or event (ADR 0008), with the chat's rules.
 * Writes replace the item's whole set, carry the version that was shown (a
 * mismatch is 409 with the current panel), and a client key for replays.
 */

type Body = Record<string, unknown>;

export async function eventReminders(
  deps: Pick<MiniAppDeps, "db" | "sourceFor">,
  user: UserRecord,
  calendarId: string,
  eventId: string,
) {
  const target = await loadEventTarget(deps, user, calendarId, eventId);
  if (!target?.anchor) return null;
  const state = await reminderState(deps, user, target);
  if ("error" in state) return null;
  return {
    title: target.title,
    when: anchorLabel(state.anchor, user.timezone),
    target: { kind: "event", calendarId, eventId },
    reminders: reminderPanel(user, state),
  };
}

async function resolveTarget(
  deps: MiniAppDeps,
  user: UserRecord,
  raw: unknown,
): Promise<ReminderTarget | null> {
  const t = (raw ?? {}) as Record<string, unknown>;
  if (t.kind === "task" && typeof t.taskId === "string") {
    const task = await findTask(deps.db, user.id, t.taskId);
    return task ? taskTarget(task) : null;
  }
  if (t.kind === "event" && typeof t.calendarId === "string" && typeof t.eventId === "string") {
    if (t.calendarId.length > 1024 || t.eventId.length > 1024) return null;
    return loadEventTarget(deps, user, t.calendarId, t.eventId);
  }
  return null;
}

async function current(deps: MiniAppDeps, user: UserRecord, target: ReminderTarget) {
  const state = await reminderState(deps, user, target);
  return "error" in state ? null : reminderPanel(user, state);
}

/** POST reminders: { target, version, action: set | add | default, codes?, text? }. */
export async function writeReminders(
  deps: MiniAppDeps,
  user: UserRecord,
  body: Body,
  key: string,
): Promise<Response> {
  const target = await resolveTarget(deps, user, body.target);
  if (!target) return apiError("not_found", 404);
  if (await findAppRequest(deps.db, user.id, key)) {
    return json({ reminders: await current(deps, user, target), replayed: true });
  }
  const state = await reminderState(deps, user, target);
  if ("error" in state) return json({ error: "not_open", message: state.error }, 409);
  const version = state.setting?.updatedAt ?? 0;
  if (body.version !== version) {
    return json({ error: "stale", reminders: reminderPanel(user, state) }, 409);
  }
  const now = deps.clock.now();

  let next: ReminderRule[] | "default";
  let notes: string[] = [];
  switch (body.action) {
    case "default":
      if (!state.setting) return json({ reminders: reminderPanel(user, state), notes });
      next = "default";
      break;
    case "set": {
      const codes = Array.isArray(body.codes) ? body.codes : null;
      if (!codes || codes.length > MAX_RULES) return apiError("bad_request", 400);
      const had = new Set(state.rules.map(encodeRule));
      const rules: ReminderRule[] = [];
      for (const code of new Set(codes)) {
        const rule = typeof code === "string" ? decodeRule(code) : null;
        if (!rule) return apiError("bad_request", 400);
        // Reminders already there may stay; new ones must still be ahead.
        const problem = had.has(code as string)
          ? null
          : checkRuleText(rule, state.anchor, user, target.kind, now);
        if (problem) return json({ error: "bad_reminder", message: problem }, 400);
        rules.push(rule);
      }
      next = rules;
      break;
    }
    case "add": {
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!text || text.length > 200) return apiError("bad_request", 400);
      const outcome = typedReminders(user, target.kind, state, text, now);
      if (outcome.kind === "error") {
        return json({ error: "bad_reminder", message: outcome.message }, 400);
      }
      if (outcome.kind === "default") {
        if (!state.setting) return json({ reminders: reminderPanel(user, state), notes });
        next = "default";
      } else {
        next = outcome.rules;
        notes = outcome.notes;
      }
      break;
    }
    default:
      return apiError("bad_request", 400);
  }

  const guard = reminderVersionGuard(user.id, target.kind, target.targetKey, version);
  const after = reminderVersionGuard(
    user.id,
    target.kind,
    target.targetKey,
    next === "default" ? 0 : now,
  );
  const write =
    next === "default"
      ? clearRemindersStatement(deps.db, user.id, target.kind, target.targetKey, guard)
      : setRemindersStatement(
          deps.db,
          user.id,
          target.kind,
          target.targetKey,
          next,
          target.kind === "event" ? (target.anchor ?? null) : null,
          now,
          guard,
        );
  let results: D1Result[];
  try {
    results = await deps.db.batch([
      write,
      recordAppRequestStatement(deps.db, user.id, key, eventOrTask(target), now, {
        sql: after.sql,
        params: [...after.params],
      }),
    ]);
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed: app_requests/.test(error.message)) {
      return json({ reminders: await current(deps, user, target), replayed: true });
    }
    throw error;
  }
  // D1 counts trigger rows too (ADR 0004): zero means the version moved.
  if ((results[0]?.meta.changes ?? 0) === 0) {
    return json({ error: "stale", reminders: await current(deps, user, target) }, 409);
  }
  return json({ reminders: await current(deps, user, target), notes });
}

function eventOrTask(target: ReminderTarget): Record<string, unknown> {
  if (target.kind === "task") return { taskId: target.targetKey };
  const [calendarId, eventId] = splitEventKey(target.targetKey);
  return { calendarId, eventId };
}
