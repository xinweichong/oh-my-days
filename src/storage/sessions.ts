import type { EventFields, EventTime } from "../domain/calendar-event";
import type { Guard } from "./guard";

/** A work session linked to a task (improvement D4). */
export interface TaskSession {
  calendarId: string;
  eventId: string;
  fields: Pick<EventFields, "start" | "end">;
}

export function insertSessionStatement(
  db: D1Database,
  userId: string,
  taskId: string,
  calendarId: string,
  eventId: string,
  startsAt: number,
  endsAt: number,
  now: number,
  guard: Guard,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO task_sessions (user_id, task_id, calendar_id, event_id, starts_at, ends_at, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${guard.sql}
       ON CONFLICT (user_id, calendar_id, event_id) DO NOTHING`,
    )
    .bind(userId, taskId, calendarId, eventId, startsAt, endsAt, now, ...guard.params);
}

export function deleteSessionStatement(
  db: D1Database,
  userId: string,
  calendarId: string,
  eventId: string,
): D1PreparedStatement {
  return db
    .prepare("DELETE FROM task_sessions WHERE user_id = ? AND calendar_id = ? AND event_id = ?")
    .bind(userId, calendarId, eventId);
}

/**
 * The task's sessions that haven't ended, earliest first. For a synced
 * calendar the synced copy is authoritative (moved or deleted in Google);
 * otherwise the times as created are shown.
 */
export async function upcomingSessions(
  db: D1Database,
  userId: string,
  taskId: string,
  now: number,
  limit: number,
): Promise<TaskSession[]> {
  const { results } = await db
    .prepare(
      `SELECT s.calendar_id, s.event_id, s.starts_at, s.ends_at, c.start_json, c.end_json,
         EXISTS (SELECT 1 FROM calendar_sync y WHERE y.user_id = s.user_id
           AND y.calendar_id = s.calendar_id) AS tracked
       FROM task_sessions s
       LEFT JOIN event_cache c ON c.user_id = s.user_id AND c.calendar_id = s.calendar_id
         AND c.event_id = s.event_id
       WHERE s.user_id = ? AND s.task_id = ?
       ORDER BY s.starts_at LIMIT 20`,
    )
    .bind(userId, taskId)
    .all<{
      calendar_id: string;
      event_id: string;
      starts_at: number;
      ends_at: number;
      start_json: string | null;
      end_json: string | null;
      tracked: number;
    }>();
  const sessions: TaskSession[] = [];
  for (const r of results) {
    if (r.tracked && r.start_json === null) continue; // deleted in Google
    const fields =
      r.start_json && r.end_json
        ? { start: JSON.parse(r.start_json) as EventTime, end: JSON.parse(r.end_json) as EventTime }
        : {
            start: { dateTime: new Date(r.starts_at).toISOString(), timeZone: "UTC" },
            end: { dateTime: new Date(r.ends_at).toISOString(), timeZone: "UTC" },
          };
    const end =
      "dateTime" in fields.end ? Date.parse(fields.end.dateTime) : Number.POSITIVE_INFINITY;
    if (end <= now) continue;
    sessions.push({ calendarId: r.calendar_id, eventId: r.event_id, fields });
  }
  return sessions.slice(0, limit);
}
