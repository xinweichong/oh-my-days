import { localDateAt } from "../domain/time";
import { type ExportRows, exportRows } from "../storage/export";
import type { UserRecord } from "../storage/users";
import { message, type Reaction } from "./reactions";
import type { SetupDeps } from "./setup";

/**
 * /export (improvement D6): the user's tasks with history, lists, recurring
 * tasks, and contacts as one JSON file in the chat. No tokens and no copy of
 * calendar events; Google Calendar keeps the events themselves.
 */

/** Telegram accepts larger files; this keeps the stored outbox row small. */
export const MAX_EXPORT_BYTES = 1_000_000;

export async function exportCommand(deps: SetupDeps, user: UserRecord): Promise<Reaction> {
  if (user.setupStep !== "done") {
    return message(user.privateChatId, "Finish setup first: send /start to continue.");
  }
  const now = deps.clock.now();
  const document = JSON.stringify(
    exportDocument(user, await exportRows(deps.db, user.id), now),
    null,
    2,
  );
  const bytes = new TextEncoder().encode(document).length;
  if (bytes > MAX_EXPORT_BYTES) {
    return message(
      user.privateChatId,
      "Your data is too large to send as one file here. Nothing was sent.",
    );
  }
  return {
    replies: [
      {
        method: "sendDocument",
        params: {
          chat_id: user.privateChatId,
          document: {
            filename: `oh-my-days-export-${localDateAt(now, user.timezone)}.json`,
            content: document,
            mime_type: "application/json",
          },
          caption:
            "Your tasks (with completed and cancelled ones), lists, recurring tasks, and contacts. Google tokens and calendar events aren't included.",
        },
      },
    ],
  };
}

const iso = (instant: number | null) => (instant === null ? null : new Date(instant).toISOString());

export function exportDocument(user: UserRecord, rows: ExportRows, now: number) {
  const listName = new Map(rows.lists.map((l) => [l.id, l.name]));
  return {
    format: "oh-my-days-export",
    version: 1,
    exportedAt: iso(now),
    timezone: user.timezone,
    lists: rows.lists.map((l) => ({ name: l.name, inbox: l.is_inbox === 1 })),
    tasks: rows.tasks.map((t) => ({
      title: t.title,
      list: listName.get(t.list_id) ?? null,
      status: t.status,
      deadline:
        t.due_kind === "date"
          ? { date: t.due_date }
          : t.due_kind === "datetime"
            ? { at: iso(t.due_at), timeZone: t.due_tz }
            : null,
      snoozedUntil: iso(t.snoozed_until),
      completedAt: iso(t.completed_at),
      cancelledAt: iso(t.cancelled_at),
      createdAt: iso(t.created_at),
      ...(t.series_id ? { series: t.series_id, occurrence: t.occurrence_date } : {}),
    })),
    series: rows.series.map((s) => ({
      id: s.id,
      title: s.title,
      list: listName.get(s.list_id) ?? null,
      repeat: { freq: s.freq, interval: s.interval, by: s.by_rule },
      firstDate: s.anchor_date,
      dueTime: s.due_time,
      timeZone: s.timezone,
      status: s.status,
    })),
    contacts: rows.contacts.map((c) => ({ name: c.name, email: c.email })),
  };
}
