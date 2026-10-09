/**
 * Reads for /export (improvement D6): only the user's own application data.
 * Tokens, the Google connection, and the synced copy of calendar events are
 * deliberately not read here.
 */

export interface ExportRows {
  lists: { id: string; name: string; is_inbox: number }[];
  tasks: {
    id: string;
    list_id: string;
    title: string;
    due_kind: string;
    due_date: string | null;
    due_at: number | null;
    due_tz: string | null;
    status: string;
    completed_at: number | null;
    cancelled_at: number | null;
    snoozed_until: number | null;
    series_id: string | null;
    occurrence_date: string | null;
    created_at: number;
  }[];
  series: {
    id: string;
    list_id: string;
    title: string;
    freq: string;
    interval: number;
    by_rule: string | null;
    anchor_date: string;
    due_time: string | null;
    timezone: string;
    status: string;
  }[];
  contacts: { name: string; email: string }[];
}

/** Bounds each section so one export stays a small file. */
export const EXPORT_ROW_LIMIT = 5000;

export async function exportRows(db: D1Database, userId: string): Promise<ExportRows> {
  const [lists, tasks, series, contacts] = await db.batch([
    db
      .prepare(
        "SELECT id, name, is_inbox FROM task_lists WHERE user_id = ? ORDER BY is_inbox DESC, name LIMIT ?",
      )
      .bind(userId, EXPORT_ROW_LIMIT),
    db
      .prepare(
        `SELECT id, list_id, title, due_kind, due_date, due_at, due_tz, status, completed_at,
           cancelled_at, snoozed_until, series_id, occurrence_date, created_at
         FROM tasks WHERE user_id = ? ORDER BY created_at LIMIT ?`,
      )
      .bind(userId, EXPORT_ROW_LIMIT),
    db
      .prepare(
        `SELECT id, list_id, title, freq, interval, by_rule, anchor_date, due_time, timezone, status
         FROM task_series WHERE user_id = ? ORDER BY created_at LIMIT ?`,
      )
      .bind(userId, EXPORT_ROW_LIMIT),
    db
      .prepare("SELECT name, email FROM contacts WHERE user_id = ? ORDER BY name LIMIT ?")
      .bind(userId, EXPORT_ROW_LIMIT),
  ]);
  return {
    lists: (lists?.results ?? []) as ExportRows["lists"],
    tasks: (tasks?.results ?? []) as ExportRows["tasks"],
    series: (series?.results ?? []) as ExportRows["series"],
    contacts: (contacts?.results ?? []) as ExportRows["contacts"],
  };
}
