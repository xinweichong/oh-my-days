import {
  checkCalendarName,
  planDefaultChange,
  planSelection,
  selectableCalendars,
} from "../application/calendar-settings";
import { unavailable } from "../application/event-flow";
import { proposeCalendar } from "../application/setup";
import { isWritable } from "../calendar/port";
import { requestForcePoll } from "../jobs/calendar-sync";
import { findAppRequest, recordAppRequestStatement } from "../storage/app-requests";
import { listStoredCalendars } from "../storage/google";
import { unguarded } from "../storage/guard";
import type { UserRecord } from "../storage/users";
import { apiError, json, type MiniAppDeps } from "./api";

/**
 * Mini App calendar management: which calendars are shown, and where new
 * events go. The rules are the chat's (application/calendar-settings). These
 * changes touch only the application's records, never Google, and each one sets
 * an absolute value, so a repeated request changes nothing further.
 */

type Body = Record<string, unknown>;

interface SyncRow {
  calendar_id: string;
  last_success_at: number | null;
  consecutive_failures: number;
}

function syncLabel(row: SyncRow | undefined, now: number): string {
  if (!row || row.last_success_at === null) return "Not synced yet";
  if (row.consecutive_failures > 0) return "Last sync failed";
  const minutes = Math.floor((now - row.last_success_at) / 60_000);
  if (minutes < 1) return "Synced just now";
  if (minutes < 60) return `Synced ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `Synced ${hours} h ago` : "Synced over a day ago";
}

export async function calendarsView(deps: Pick<MiniAppDeps, "db">, user: UserRecord, now: number) {
  const [stored, sync] = await Promise.all([
    listStoredCalendars(deps.db, user.id),
    deps.db
      .prepare(
        "SELECT calendar_id, last_success_at, consecutive_failures FROM calendar_sync WHERE user_id = ?",
      )
      .bind(user.id)
      .all<SyncRow>(),
  ]);
  const syncs = new Map(sync.results.map((r) => [r.calendar_id, r]));
  const task = stored.find((c) => c.listed && c.calendarId === user.taskCalendarId);
  const shown = selectableCalendars(user, stored);
  return {
    calendars: shown.map((c) => ({
      id: c.calendarId,
      name: c.summary,
      access: isWritable(c.accessRole) ? (c.accessRole === "owner" ? "owner" : "edit") : "view",
      selected: c.selected,
      isDefault: c.calendarId === user.defaultCalendarId,
      canBeDefault: isWritable(c.accessRole),
      sync: syncLabel(syncs.get(c.calendarId), now),
    })),
    task: task ? { name: task.summary, sync: syncLabel(syncs.get(task.calendarId), now) } : null,
  };
}

const REASONS = {
  unavailable: ["unavailable", 404],
  not_writable: ["not_writable", 409],
  last_selected: ["last_selected", 409],
  is_default: ["is_default", 409],
} as const;

export async function calendarWrite(
  deps: MiniAppDeps,
  user: UserRecord,
  action: string,
  body: Body,
): Promise<Response> {
  const now = deps.clock.now();
  if (action === "sync") {
    const result = await requestForcePoll(deps.db, user.id, now);
    return json({ result });
  }
  const calendarId = typeof body.calendarId === "string" ? body.calendarId : "";
  if (!calendarId || calendarId.length > 1024) return apiError("bad_request", 400);
  const stored = await listStoredCalendars(deps.db, user.id);
  let change: ReturnType<typeof planSelection>;
  if (action === "select") {
    if (typeof body.selected !== "boolean") return apiError("bad_request", 400);
    change = planSelection(user, stored, calendarId, body.selected, now, { keepOne: true });
  } else if (action === "default") {
    change = planDefaultChange(user, stored, calendarId, now);
  } else {
    return apiError("not_found", 404);
  }
  if (!change.ok) {
    const [code, status] = REASONS[change.reason];
    return apiError(code, status);
  }
  await deps.db.batch(change.statements(deps.db, unguarded));
  const defaultCalendarId = action === "default" ? calendarId : user.defaultCalendarId;
  return json(await calendarsView(deps, { ...user, defaultCalendarId }, now));
}

/**
 * Creates a calendar through the chat's operation: durable, retried, and
 * reconciled if Google's answer is lost. The answer here is only "started"; the
 * calendar appears once Google has confirmed it, and the chat says so too.
 */
export async function calendarCreate(
  deps: MiniAppDeps,
  user: UserRecord,
  body: Body,
  key: string,
): Promise<Response> {
  const now = deps.clock.now();
  if (await findAppRequest(deps.db, user.id, key)) return json({ started: true, replayed: true });
  const checked = checkCalendarName(
    typeof body.name === "string" ? body.name : "",
    await listStoredCalendars(deps.db, user.id),
  );
  if (!checked.ok) return apiError(checked.reason, checked.reason === "bad_name" ? 400 : 409);
  if (await unavailable(deps, user)) return apiError("reconnect", 409);
  // One creation at a time: a second could not be told from the first if Google's answer is lost.
  const open = await deps.db
    .prepare(
      `SELECT COUNT(*) AS n FROM operations WHERE user_id = ? AND kind = 'calendar.create'
         AND status IN ('ready', 'applying', 'retry_wait', 'needs_resolution', 'auth_required')`,
    )
    .bind(user.id)
    .first<{ n: number }>();
  if ((open?.n ?? 0) > 0) return apiError("creating", 409);

  // With no default yet, the new calendar becomes it.
  const makeDefault = body.makeDefault === true || !user.defaultCalendarId;
  const prepared = await proposeCalendar(
    deps,
    user,
    makeDefault ? "default" : "extra",
    checked.name,
    `app-calendar:${key}`,
  );
  try {
    await deps.db.batch([
      ...(prepared.statements?.(deps.db, unguarded) ?? []),
      recordAppRequestStatement(deps.db, user.id, key, { kind: "calendar" }, now),
    ]);
  } catch (error) {
    // The key was already used: this is a retry of a request that went through.
    if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) {
      return json({ started: true, replayed: true });
    }
    throw error;
  }
  return json({ started: true, name: checked.name, makeDefault });
}
