import type { AppConfig } from "../env";
import { providerFailure } from "./event-operations";
import type { OperationHandler } from "./operation-types";
import { calendarCreated } from "./setup";

export const CREATE_CALENDAR = "calendar.create";

export interface CreateCalendarIntent {
  /** `task` creates the dedicated task calendar; `default` a new default for events. */
  purpose: "default" | "task";
  summary: string;
  timeZone: string;
  /** Calendar IDs known before the request, to recognize this one after a lost response. */
  knownCalendarIds: string[];
}

interface CreateCalendarResult {
  calendarId: string;
  summary: string;
}

/**
 * Creates a secondary calendar. Google assigns calendar IDs, so a create whose
 * response was lost is reconciled by listing calendars and finding a new owned
 * calendar with the requested name, rather than creating a second one.
 */
export function createCalendarHandler(config: AppConfig): OperationHandler {
  return {
    kind: CREATE_CALENDAR,

    async execute({ op, directory }) {
      if (!directory) return { kind: "auth_required" };
      const intent = op.intent as CreateCalendarIntent;

      if (op.outcomeUnknown) {
        const listed = await directory.listCalendars();
        if (!listed.ok) return providerFailure(listed.error);
        const known = new Set(intent.knownCalendarIds);
        const created = listed.value.find(
          (c) =>
            c.summary === intent.summary && c.accessRole === "owner" && !known.has(c.calendarId),
        );
        if (created) {
          return {
            kind: "succeeded",
            result: { calendarId: created.calendarId, summary: created.summary },
          };
        }
      }

      const created = await directory.createCalendar(intent.summary, intent.timeZone);
      if (!created.ok) return providerFailure(created.error);
      return {
        kind: "succeeded",
        result: { calendarId: created.value.calendarId, summary: intent.summary },
      };
    },

    notice(op, event) {
      const intent = op.intent as CreateCalendarIntent;
      const name = intent.summary;
      switch (event.kind) {
        case "succeeded":
          return intent.purpose === "task"
            ? `Created ${name} for task deadlines.`
            : `Created ${name}. New events go there unless you name another calendar.`;
        case "pending":
          return event.outcomeUnknown
            ? `Pending: I couldn't confirm that ${name} was created. I'll check again automatically.`
            : `Pending: ${name} hasn't been created in Google Calendar yet. I'll retry automatically.`;
        case "auth_required":
          return `Google Calendar needs to be reconnected before I can create ${name}.`;
        case "failed":
          return `I couldn't create ${name}. Send /settings to try again.`;
        case "needs_resolution":
          return `${name} still hasn't been created. I've stopped retrying; check /health.`;
        default:
          return null;
      }
    },

    async onSucceeded({ op, user, result, db, ids, now }) {
      const intent = op.intent as CreateCalendarIntent;
      const { calendarId, summary } = result as CreateCalendarResult;
      const record = {
        replies: [],
        statements: (database: D1Database) => [
          database
            .prepare(
              `INSERT INTO calendars (user_id, calendar_id, summary, access_role, is_primary,
                 selected, listed, updated_at)
               VALUES (?, ?, ?, 'owner', 0, 0, 1, ?)
               ON CONFLICT (user_id, calendar_id) DO UPDATE SET listed = 1, updated_at = excluded.updated_at`,
            )
            .bind(user.id, calendarId, summary, now),
        ],
      };
      const follow = await calendarCreated(
        { db, ids, clock: { now: () => now }, config },
        user,
        intent.purpose,
        calendarId,
      );
      return {
        replies: follow.replies,
        statements: (database, guard) => [
          ...record.statements(database),
          ...(follow.statements?.(database, guard) ?? []),
        ],
      };
    },
  };
}
