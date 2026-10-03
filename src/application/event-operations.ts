import type { CalendarEvent, ProviderError } from "../calendar/port";
import { type EventField, type EventFields, pickEventFields } from "../domain/calendar-event";
import { mergeIntended, valuesEqual } from "../domain/field-merge";
import { cacheOwnWriteStatement, deleteEventStatement } from "../storage/events";
import type { UserRecord } from "../storage/users";
import { formatEventRange } from "../telegram/format";
import type {
  ExecutionOutcome,
  NoticeEvent,
  OperationHandler,
  SucceededContext,
} from "./operation-types";
import { canCheckOverlaps, findOverlaps, type Overlap } from "./overlaps";
import type { Reaction } from "./reactions";

/**
 * Calendar event operations through the shared pipeline. Each attempt reads
 * provider state before writing, so retries and unknown outcomes reconcile
 * instead of repeating a change.
 */

export const CREATE_EVENT = "calendar.event.create";
export const PATCH_EVENT = "calendar.event.patch";
export const DELETE_EVENT = "calendar.event.delete";

/** Display and conflict-check details shared by event intents. */
interface EventContext {
  /** Calendar name as shown when requested, for messages. */
  calendarName?: string;
  /** Calendars to check for overlapping events after the write. */
  overlapCalendarIds?: string[];
}

export interface CreateEventIntent extends EventContext {
  calendarId: string;
  /** Client-chosen provider ID: a repeated create finds the first one. */
  eventId: string;
  fields: EventFields;
}

export interface PatchEventIntent extends EventContext {
  calendarId: string;
  eventId: string;
  /** The event title as shown when the change was requested, for messages. */
  title: string;
  /** Values of the patched fields when the change was requested. */
  base: Partial<EventFields>;
  patch: Partial<EventFields>;
  /** Set for Undo: any intervening edit makes Undo unavailable rather than a conflict. */
  undo?: true;
}

export interface DeleteEventIntent {
  calendarId: string;
  eventId: string;
  /** The event as previewed; a different current event requires a new confirmation. */
  base: EventFields;
  undo?: true;
}

interface WriteResult {
  fields: EventFields;
  etag: string;
  /** Null when overlaps could not be checked; absent when not requested. */
  overlaps?: Overlap[] | null;
}

type CreateResult = WriteResult;

interface PatchResult extends WriteResult {
  before: Partial<EventFields>;
  after: Partial<EventFields>;
}

interface DeleteResult {
  fields: EventFields;
}

/** Maps provider failures that need no operation-specific handling. */
export function providerFailure(error: ProviderError): ExecutionOutcome {
  switch (error.kind) {
    case "retryable":
      return {
        kind: "retry",
        errorClass: "provider_unavailable",
        retryAfterMs: error.retryAfterMs,
      };
    case "outcome_unknown":
      return { kind: "retry", errorClass: "outcome_unknown", outcomeUnknown: true };
    case "conflict":
      // The version moved between read and write; the next attempt re-reads it.
      return { kind: "retry", errorClass: "version_conflict", retryAfterMs: 1_000 };
    case "auth_required":
      return { kind: "auth_required" };
    case "forbidden":
      return { kind: "failed", errorClass: "forbidden" };
    case "not_found":
      return { kind: "failed", errorClass: "not_found" };
    case "validation_failed":
      return { kind: "failed", errorClass: "validation_failed" };
  }
}

function isLive(event: CalendarEvent): boolean {
  return event.status !== "cancelled";
}

export const createEventHandler: OperationHandler = {
  kind: CREATE_EVENT,

  async execute({ op, calendar }) {
    if (!calendar) return { kind: "auth_required" };
    const intent = op.intent as CreateEventIntent;
    const inserted = await calendar.insertEvent(intent.calendarId, intent.eventId, intent.fields);
    let written: CalendarEvent;
    if (inserted.ok) {
      written = inserted.value;
    } else {
      if (inserted.error.kind !== "conflict") return providerFailure(inserted.error);
      // The ID already exists: an earlier attempt of this operation created it.
      const existing = await calendar.getEvent(intent.calendarId, intent.eventId);
      if (!existing.ok) return providerFailure(existing.error);
      if (!isLive(existing.value)) {
        return { kind: "needs_resolution", reason: "deleted_after_create" };
      }
      written = existing.value;
    }
    return succeeded<CreateResult>({
      fields: written.fields,
      etag: written.etag,
      ...(await overlapsFor(calendar, intent, written)),
    });
  },

  notice(op, event, user) {
    const intent = op.intent as CreateEventIntent;
    const title = intent.fields.summary;
    switch (event.kind) {
      case "succeeded":
        return writtenNotice("Event added", event.result as CreateResult, intent, user);
      case "pending":
        return event.outcomeUnknown
          ? `Pending: I couldn't confirm that ${title} was added to Google Calendar. I'll check again automatically.`
          : `Pending: ${title} has not been added to Google Calendar. I'll retry automatically.`;
      default:
        return commonNotice(title, event, "add");
    }
  },

  onSucceeded: cacheWrite,

  inverse(op, user) {
    const intent = op.intent as CreateEventIntent;
    const result = op.result as CreateResult;
    const undo: DeleteEventIntent = {
      calendarId: intent.calendarId,
      eventId: intent.eventId,
      base: result.fields,
      undo: true,
    };
    // Undoing a create deletes the event, so it is confirmed like any deletion.
    // It stays bound to the created version and is refused if edited since.
    return { kind: DELETE_EVENT, intent: undo, confirmation: deletePreview(undo, user) };
  },
};

export const patchEventHandler: OperationHandler = {
  kind: PATCH_EVENT,

  async execute({ op, calendar }) {
    if (!calendar) return { kind: "auth_required" };
    const intent = op.intent as PatchEventIntent;
    const current = await calendar.getEvent(intent.calendarId, intent.eventId);
    if (!current.ok && current.error.kind !== "not_found") return providerFailure(current.error);
    if (!current.ok || !isLive(current.value)) {
      return intent.undo
        ? { kind: "failed", errorClass: "undo_stale" }
        : { kind: "needs_resolution", reason: "target_missing" };
    }

    const merge = mergeIntended(intent.base, current.value.fields, intent.patch);
    if (merge.conflicts.length > 0) {
      if (intent.undo) return { kind: "failed", errorClass: "undo_stale" };
      return {
        kind: "needs_resolution",
        reason: "field_conflict",
        details: {
          fields: merge.conflicts,
          current: pickEventFields(current.value.fields, merge.conflicts as EventField[]),
        },
      };
    }
    const result = async (written: CalendarEvent): Promise<ExecutionOutcome> =>
      succeeded<PatchResult>({
        before: intent.base,
        after: intent.patch,
        fields: written.fields,
        etag: written.etag,
        // Only a time change can create a new overlap.
        ...(intent.patch.start || intent.patch.end
          ? await overlapsFor(calendar, intent, written)
          : {}),
      });
    // Nothing left to write: an earlier attempt (or someone else) already applied it.
    if (Object.keys(merge.patch).length === 0) return result(current.value);

    const patched = await calendar.patchEvent(
      intent.calendarId,
      intent.eventId,
      merge.patch as Partial<EventFields>,
      current.value.etag,
    );
    if (!patched.ok) return providerFailure(patched.error);
    return result(patched.value);
  },

  notice(op, event, user) {
    const intent = op.intent as PatchEventIntent;
    const fields = event.kind === "succeeded" ? (event.result as PatchResult).fields : null;
    const title = fields?.summary ?? intent.patch.summary ?? intent.title;
    switch (event.kind) {
      case "succeeded":
        return writtenNotice(
          intent.undo ? "Undone" : "Event updated",
          event.result as PatchResult,
          intent,
          user,
        );
      case "pending":
        return event.outcomeUnknown
          ? `Pending: I couldn't confirm that the change to ${title} reached Google Calendar. I'll check again automatically.`
          : `Pending: the change to ${title} has not reached Google Calendar. I'll retry automatically.`;
      case "needs_resolution":
        if (event.reason === "field_conflict") {
          return `${title} changed in Calendar while your change was pending. Nothing was overwritten.`;
        }
        if (event.reason === "target_missing") {
          return `I couldn't find ${title} in Google Calendar anymore. Nothing was changed.`;
        }
        return commonNotice(title, event, "update");
      default:
        return commonNotice(title, event, "update");
    }
  },

  onSucceeded: cacheWrite,

  inverse(op) {
    const intent = op.intent as PatchEventIntent;
    if (intent.undo) return null;
    const result = op.result as PatchResult;
    return {
      kind: PATCH_EVENT,
      intent: {
        calendarId: intent.calendarId,
        eventId: intent.eventId,
        title: result.fields.summary,
        base: result.after,
        patch: result.before,
        undo: true,
      } satisfies PatchEventIntent,
      confirmation: null,
    };
  },
};

export const deleteEventHandler: OperationHandler = {
  kind: DELETE_EVENT,

  async onSucceeded({ op, user }) {
    const intent = op.intent as DeleteEventIntent;
    return {
      replies: [],
      statements: (db, guard) => [
        deleteEventStatement(db, user.id, intent.calendarId, intent.eventId, guard),
      ],
    };
  },

  async execute({ op, calendar, user }) {
    if (!calendar) return { kind: "auth_required" };
    const intent = op.intent as DeleteEventIntent;
    const current = await calendar.getEvent(intent.calendarId, intent.eventId);
    if (!current.ok && current.error.kind !== "not_found") return providerFailure(current.error);
    // Already gone, whether by an earlier attempt or externally: the goal holds.
    if (!current.ok || !isLive(current.value)) {
      return succeeded<DeleteResult>({ fields: intent.base });
    }

    if (!valuesEqual(pickEventFields(current.value.fields), pickEventFields(intent.base))) {
      if (intent.undo) return { kind: "failed", errorClass: "undo_stale" };
      const next: DeleteEventIntent = { ...intent, base: current.value.fields };
      return {
        kind: "needs_reconfirmation",
        intent: next,
        preview: deletePreview(next, user),
      };
    }

    const deleted = await calendar.deleteEvent(
      intent.calendarId,
      intent.eventId,
      current.value.etag,
    );
    if (!deleted.ok && deleted.error.kind !== "not_found") return providerFailure(deleted.error);
    return succeeded<DeleteResult>({ fields: intent.base });
  },

  notice(op, event, user) {
    const intent = op.intent as DeleteEventIntent;
    const title = intent.base.summary;
    switch (event.kind) {
      case "succeeded":
        return intent.undo
          ? `Undone: ${title} was removed from Google Calendar.`
          : `Event deleted: ${title}\n${formatEventRange(intent.base, user.timezone)}`;
      case "needs_reconfirmation":
        return `${title} changed since you asked to delete it.\n\n${event.preview.text}`;
      case "pending":
        return event.outcomeUnknown
          ? `Pending: I couldn't confirm that ${title} was deleted from Google Calendar. I'll check again automatically.`
          : `Pending: ${title} has not been deleted from Google Calendar. I'll retry automatically.`;
      case "failed":
        if (event.errorClass === "undo_stale") {
          return `Undo isn't available: ${title} changed in Calendar since it was added.`;
        }
        return commonNotice(title, event, "delete");
      default:
        return commonNotice(title, event, "delete");
    }
  },
};

/** The confirmation shown before deleting an event. */
export function deletePreview(
  intent: DeleteEventIntent,
  user: UserRecord,
): { text: string; confirmLabel: string; facts: unknown } {
  return {
    text: `Delete event: ${intent.base.summary}\n${formatEventRange(intent.base, user.timezone)}\n\nThis removes it from Google Calendar.`,
    confirmLabel: "Delete",
    facts: { calendarId: intent.calendarId, eventId: intent.eventId, base: intent.base },
  };
}

async function overlapsFor(
  calendar: object,
  intent: EventContext,
  written: CalendarEvent,
): Promise<{ overlaps?: Overlap[] | null }> {
  const ids = intent.overlapCalendarIds;
  const { start, end } = written.fields;
  if (
    !ids?.length ||
    !canCheckOverlaps(calendar) ||
    !("dateTime" in start) ||
    !("dateTime" in end)
  ) {
    return {};
  }
  return {
    overlaps: await findOverlaps(
      calendar,
      ids,
      Date.parse(start.dateTime),
      Date.parse(end.dateTime),
      written.id,
    ),
  };
}

/** "Event added: Dinner / Fri 9 Oct 2026, 7–8pm · Personal", plus any overlaps. */
function writtenNotice(
  heading: string,
  result: WriteResult,
  intent: EventContext,
  user: UserRecord,
): string {
  const where = intent.calendarName ? ` · ${intent.calendarName}` : "";
  const lines = [
    `${heading}: ${result.fields.summary}`,
    `${formatEventRange(result.fields, user.timezone)}${where}`,
  ];
  if (result.overlaps === null) {
    lines.push("", "I couldn't check for overlapping events.");
  } else if (result.overlaps && result.overlaps.length > 0) {
    lines.push(
      "",
      "Overlaps with:",
      ...result.overlaps.map((o) => `• ${o.summary}, ${formatEventRange(o, user.timezone)}`),
    );
  }
  return lines.join("\n");
}

/** Keeps the event cache in step with the bot's own successful writes. */
async function cacheWrite({ op, user, result, now }: SucceededContext): Promise<Reaction> {
  const intent = op.intent as { calendarId: string; eventId: string };
  const written = result as WriteResult;
  return {
    replies: [],
    statements: (db, guard) => [
      cacheOwnWriteStatement(
        db,
        user.id,
        intent.calendarId,
        intent.eventId,
        written.etag,
        written.fields,
        now,
        guard,
      ),
    ],
  };
}

function succeeded<T>(result: T): ExecutionOutcome {
  return { kind: "succeeded", result };
}

function commonNotice(
  title: string,
  event: NoticeEvent,
  verb: "add" | "update" | "delete",
): string | null {
  switch (event.kind) {
    case "auth_required":
      return `Google Calendar needs to be reconnected before I can ${verb} ${title}. Nothing has changed yet.`;
    case "failed":
      if (event.errorClass === "forbidden") {
        return `I can't ${verb} ${title}: this calendar doesn't allow changes from your account.`;
      }
      if (event.errorClass === "undo_stale") {
        return `Undo isn't available: ${title} changed in Calendar since.`;
      }
      return `I couldn't ${verb} ${title}. Nothing further will be attempted.`;
    case "needs_resolution":
      return `${title} still hasn't synced with Google Calendar. I've stopped retrying; check /health.`;
    default:
      return null;
  }
}

export const eventOperationHandlers = [
  createEventHandler,
  patchEventHandler,
  deleteEventHandler,
] as const;
