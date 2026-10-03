import type { CalendarEvent } from "../calendar/port";
import type { EventFields } from "../domain/calendar-event";
import { mergeIntended } from "../domain/field-merge";
import { desiredMarker } from "../domain/tasks";
import type { IdGenerator } from "../shared/ids";
import type { Guard } from "../storage/guard";
import { insertOperationStatement } from "../storage/operations";
import { findTask, setProjectionStatement, type TaskRecord } from "../storage/tasks";
import { providerFailure } from "./event-operations";
import type { ExecutionOutcome, OperationHandler } from "./operation-types";

/**
 * Keeps a task's deadline marker in the task calendar in step with the task.
 * The operation carries only the task ID: each attempt projects the task's
 * current state, so retries never write a stale marker.
 */
export const PROJECT_TASK = "task.project";

export interface ProjectTaskIntent {
  taskId: string;
  /** Title when requested, for messages. */
  title: string;
}

type ProjectionResult =
  | { kind: "written"; calendarId: string; eventId: string; etag: string; fields: EventFields }
  | { kind: "removed" }
  /** The marker was deleted in Calendar; sync turns that into a cancellation. */
  | { kind: "gone" }
  | { kind: "unchanged" };

const MARKER_EXTRAS = { transparent: true, silent: true };

/** Queues projection of the task's state after a change that produces `version`. */
export function projectTaskStatement(
  db: D1Database,
  ids: IdGenerator,
  task: Pick<TaskRecord, "id" | "userId" | "title">,
  version: number,
  now: number,
  guard: Guard,
): D1PreparedStatement {
  return insertOperationStatement(
    db,
    {
      id: ids.next(),
      userId: task.userId,
      kind: PROJECT_TASK,
      idempotencyKey: `project:${task.id}:${version}`,
      intent: { taskId: task.id, title: task.title } satisfies ProjectTaskIntent,
      status: "ready",
      preview: null,
      previewHash: null,
      confirmationExpiresAt: null,
    },
    now,
    guard,
  );
}

export const projectTaskHandler: OperationHandler = {
  kind: PROJECT_TASK,

  async execute({ op, user, calendar, db }) {
    const intent = op.intent as ProjectTaskIntent;
    const task = await findTask(db, user.id, intent.taskId);
    if (!task) return done({ kind: "unchanged" });
    const desired = desiredMarker(task);
    const link = task.projection;
    if (!desired && !link) return done({ kind: "unchanged" });
    if (!calendar) return { kind: "auth_required" };

    if (!link) {
      const calendarId = user.taskCalendarId;
      if (!calendarId || !desired) return { kind: "failed", errorClass: "no_task_calendar" };
      // The operation ID is the marker ID: stable across this operation's
      // retries, so a repeated insert finds the first, and new for each later
      // projection (Google keeps deleted IDs, so they cannot be reused).
      const markerId = op.id;
      const inserted = await calendar.insertEvent(calendarId, markerId, desired, {
        ...MARKER_EXTRAS,
        privateProperties: { ohMyDaysTask: task.id },
      });
      if (inserted.ok) return written(calendarId, inserted.value);
      if (inserted.error.kind !== "conflict") return providerFailure(inserted.error);
      const existing = await calendar.getEvent(calendarId, markerId);
      if (!existing.ok) return providerFailure(existing.error);
      if (existing.value.status === "cancelled") return done({ kind: "gone" });
      return written(calendarId, existing.value);
    }

    const current = await calendar.getEvent(link.calendarId, link.eventId);
    if (!current.ok && current.error.kind !== "not_found") return providerFailure(current.error);
    const gone = !current.ok || current.value.status === "cancelled";

    if (!desired) {
      // Removing a deadline (or cancelling) removes the marker. The deletion's
      // echo in sync is recognized because the task no longer wants a marker.
      if (gone) return done({ kind: "removed" });
      const deleted = await calendar.deleteEvent(link.calendarId, link.eventId, current.value.etag);
      if (!deleted.ok && deleted.error.kind !== "not_found") return providerFailure(deleted.error);
      return done({ kind: "removed" });
    }
    // Deleted in Calendar: never recreate it over the user's deletion.
    if (gone) return done({ kind: "gone" });

    const base = task.projected ?? current.value.fields;
    const merge = mergeIntended(base, current.value.fields, desired);
    if (merge.conflicts.length > 0) {
      // An external edit has not been imported yet; sync imports it, then this retries.
      return { kind: "retry", errorClass: "awaiting_sync", retryAfterMs: 60_000 };
    }
    if (Object.keys(merge.patch).length === 0) return written(link.calendarId, current.value);
    const patched = await calendar.patchEvent(
      link.calendarId,
      link.eventId,
      merge.patch as Partial<EventFields>,
      current.value.etag,
      MARKER_EXTRAS,
    );
    if (!patched.ok) return providerFailure(patched.error);
    return written(link.calendarId, patched.value);
  },

  notice(op, event) {
    const { title } = op.intent as ProjectTaskIntent;
    switch (event.kind) {
      case "succeeded":
        return null; // The task change was already confirmed in Telegram.
      case "pending":
        return event.outcomeUnknown
          ? `Pending: I couldn't confirm that the deadline for ${title} reached Google Calendar. I'll check again automatically.`
          : `Pending: the deadline for ${title} hasn't reached Google Calendar yet. I'll retry automatically.`;
      case "auth_required":
        return `Google Calendar needs to be reconnected before the deadline for ${title} can be updated there.`;
      case "failed":
        return event.errorClass === "no_task_calendar"
          ? `The deadline for ${title} isn't in Google Calendar because no task calendar is set up. Send /start to finish setup.`
          : `I couldn't update the deadline for ${title} in Google Calendar.`;
      case "needs_resolution":
        return `The deadline for ${title} still hasn't synced with Google Calendar. I've stopped retrying; check /health.`;
      default:
        return null;
    }
  },

  async onSucceeded({ op, user, result, now }) {
    const { taskId } = op.intent as ProjectTaskIntent;
    const outcome = result as ProjectionResult;
    if (outcome.kind === "written") {
      return {
        replies: [],
        statements: (db, guard) => [
          setProjectionStatement(db, user.id, taskId, outcome, now, guard),
        ],
      };
    }
    if (outcome.kind === "removed") {
      return {
        replies: [],
        statements: (db, guard) => [setProjectionStatement(db, user.id, taskId, null, now, guard)],
      };
    }
    return { replies: [] };
  },
};

function done(result: ProjectionResult): ExecutionOutcome {
  return { kind: "succeeded", result };
}

function written(calendarId: string, event: CalendarEvent): ExecutionOutcome {
  return done({
    kind: "written",
    calendarId,
    eventId: event.id,
    etag: event.etag,
    fields: event.fields,
  });
}
