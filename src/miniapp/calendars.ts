import {
  planDefaultChange,
  planSelection,
  selectableCalendars,
} from "../application/calendar-settings";
import { isWritable } from "../calendar/port";
import { requestForcePoll } from "../jobs/calendar-sync";
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
