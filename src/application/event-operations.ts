import type { CalendarEvent, ProviderError } from "../calendar/port";
import { type EventField, type EventFields, pickEventFields } from "../domain/calendar-event";
import { mergeIntended, valuesEqual } from "../domain/field-merge";
import { DEFAULT_EVENT_REMINDER_MINUTES, reminderKeys } from "../domain/schedule";
import { cacheOwnWriteStatement, deleteEventStatement } from "../storage/events";
import type { ItemRef } from "../storage/outbox";
import { claimReminderStatement } from "../storage/reminders";
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
  /** For a recurring event: its rules and the interpreted schedule shown to the user. */
  recurrence?: string[];
  repeatLabel?: string;
}

/**
 * Present when Google should email guests about the change. The recipients are
 * the guests the user confirmed; if the guest list differs when the change is
 * applied, the user is asked again (spec §8).
 */
export interface GuestNotice {
  recipients: string[];
}

export interface PatchEventIntent extends EventContext {
  /** "series" when the change applies to every occurrence (confirmed first). */
  scope?: "series";
  notify?: GuestNotice;
  /** New guests to invite (merged with existing guests; invitations are emailed). */
  addAttendees?: string[];
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
  /** "series" when deleting every occurrence of a recurring event. */
  scope?: "series";
  notify?: GuestNotice;
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

/** Event operations' messages are about the event they change. */
function aboutEvent(op: { intent: unknown }): ItemRef {
  const intent = op.intent as { calendarId: string; eventId: string };
  return { kind: "event", calendarId: intent.calendarId, eventId: intent.eventId };
}

export const createEventHandler: OperationHandler = {
  kind: CREATE_EVENT,
  about: aboutEvent,

  async execute({ op, calendar }) {
    if (!calendar) return { kind: "auth_required" };
    const intent = op.intent as CreateEventIntent;
    const inserted = await calendar.insertEvent(
      intent.calendarId,
      intent.eventId,
      intent.fields,
      intent.recurrence ? { recurrence: intent.recurrence } : undefined,
    );
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
        return withRepeat(
          writtenNotice("Event added", event.result as CreateResult, intent, user),
          intent,
        );
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
  about: aboutEvent,

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

    const guests = current.value.attendees ?? [];
    const invited = intent.addAttendees ?? [];
    if (intent.notify) {
      // The confirmed recipients must still be the event's guests (plus invitees).
      const expected = intent.notify.recipients.filter((r) => !invited.includes(r));
      const existing = guests.filter((g) => !invited.includes(g));
      if (!sameAddresses(existing, expected)) {
        const next: PatchEventIntent = {
          ...intent,
          notify: { recipients: unique([...existing, ...invited]) },
        };
        return { kind: "needs_reconfirmation", intent: next, preview: guestChangePreview(next) };
      }
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
    const missingGuests = invited.filter((g) => !guests.includes(g));
    // Nothing left to write: an earlier attempt (or someone else) already applied it.
    // A notifying write is never repeated once applied, so no second email is sent.
    if (Object.keys(merge.patch).length === 0 && missingGuests.length === 0) {
      return result(current.value);
    }

    const patched = await calendar.patchEvent(
      intent.calendarId,
      intent.eventId,
      merge.patch as Partial<EventFields>,
      current.value.etag,
      intent.notify
        ? {
            notifyGuests: true,
            ...(missingGuests.length ? { attendees: unique([...guests, ...invited]) } : {}),
          }
        : undefined,
    );
    if (!patched.ok) return providerFailure(patched.error);
    return result(patched.value);
  },

  notice(op, event, user) {
    const intent = op.intent as PatchEventIntent;
    const fields = event.kind === "succeeded" ? (event.result as PatchResult).fields : null;
    const title = fields?.summary ?? intent.patch.summary ?? intent.title;
    switch (event.kind) {
      case "succeeded": {
        if (intent.addAttendees?.length) {
          return `Invitations sent for ${title}:\n${intent.addAttendees.map((a) => `• ${a}`).join("\n")}`;
        }
        const text = writtenNotice(
          intent.undo ? "Undone" : intent.scope === "series" ? "Series updated" : "Event updated",
          event.result as PatchResult,
          intent,
          user,
        );
        return intent.notify ? `${text}\n\n${guestsEmailed(intent.notify)}` : text;
      }
      case "needs_reconfirmation":
        return `The guests of ${title} changed since you confirmed.\n\n${event.preview.text}`;
      case "pending":
        return event.outcomeUnknown
          ? `Pending: I couldn't confirm that the change to ${title} reached Google Calendar. I'll check again automatically.`
          : `Pending: the change to ${title} has not reached Google Calendar. I'll retry automatically.`;
      case "needs_resolution":
        if (event.reason === "field_conflict") {
          return conflictNotice(title, intent, event.details, user);
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
    if (intent.undo || intent.addAttendees?.length) return null;
    const result = op.result as PatchResult;
    const inverse: PatchEventIntent = {
      calendarId: intent.calendarId,
      eventId: intent.eventId,
      title: result.fields.summary,
      base: result.after,
      patch: result.before,
      undo: true,
      ...(intent.notify ? { notify: intent.notify } : {}),
    };
    // Undoing a change guests were told about tells them again, so it is confirmed.
    if (intent.notify) {
      return { kind: PATCH_EVENT, intent: inverse, confirmation: guestChangePreview(inverse) };
    }
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

    if (intent.notify && !sameAddresses(current.value.attendees ?? [], intent.notify.recipients)) {
      const next: DeleteEventIntent = {
        ...intent,
        notify: { recipients: current.value.attendees ?? [] },
      };
      return { kind: "needs_reconfirmation", intent: next, preview: deletePreview(next, user) };
    }
    const deleted = await calendar.deleteEvent(
      intent.calendarId,
      intent.eventId,
      current.value.etag,
      intent.notify ? { notifyGuests: true } : undefined,
    );
    if (!deleted.ok && deleted.error.kind !== "not_found") return providerFailure(deleted.error);
    return succeeded<DeleteResult>({ fields: intent.base });
  },

  notice(op, event, user) {
    const intent = op.intent as DeleteEventIntent;
    const title = intent.base.summary;
    switch (event.kind) {
      case "succeeded":
        if (intent.undo) return `Undone: ${title} was removed from Google Calendar.`;
        if (intent.scope === "series") {
          return `Deleted every occurrence of ${title}.${intent.notify ? `\n\n${guestsEmailed(intent.notify, "cancellation")}` : ""}`;
        }
        return `Event deleted: ${title}\n${formatEventRange(intent.base, user.timezone)}${intent.notify ? `\n\n${guestsEmailed(intent.notify, "cancellation")}` : ""}`;
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
  // Guests are listed so the user sees exactly who Google will email.
  const guests = intent.notify
    ? `\n\nGoogle will email a cancellation to:\n${intent.notify.recipients.map((r) => `• ${r}`).join("\n")}`
    : "";
  const facts = {
    calendarId: intent.calendarId,
    eventId: intent.eventId,
    base: intent.base,
    scope: intent.scope ?? null,
    recipients: intent.notify?.recipients ?? null,
  };
  if (intent.scope === "series") {
    return {
      text: `Delete every occurrence of ${intent.base.summary}?\n\nThis removes the whole recurring series from Google Calendar.${guests}`,
      confirmLabel: intent.notify ? "Delete and notify" : "Delete series",
      facts,
    };
  }
  if (intent.notify) {
    return {
      text: `Delete event: ${intent.base.summary}\n${formatEventRange(intent.base, user.timezone)}${guests}`,
      confirmLabel: "Delete and notify",
      facts,
    };
  }
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

function withRepeat(text: string, intent: CreateEventIntent): string {
  if (!intent.repeatLabel) return text;
  const [first, second, ...rest] = text.split("\n");
  return [first, second, `Repeats: ${intent.repeatLabel}`, ...rest].join("\n");
}

/** Keeps the event cache in step with the bot's own successful writes. */
async function cacheWrite({ op, user, result, now }: SucceededContext): Promise<Reaction> {
  const intent = op.intent as { calendarId: string; eventId: string };
  const written = result as WriteResult;
  const start = written.fields.start;
  const startsAt = "dateTime" in start ? Date.parse(start.dateTime) : null;
  // Created or moved inside the reminder window: this confirmation is the
  // approaching notice, so no separate reminder follows.
  const insideWindow =
    startsAt !== null &&
    startsAt > now &&
    startsAt - DEFAULT_EVENT_REMINDER_MINUTES * 60_000 <= now;
  return {
    replies: [],
    statements: (db, guard) => [
      ...(insideWindow && startsAt !== null
        ? [
            claimReminderStatement(
              db,
              user.id,
              reminderKeys.event(
                intent.calendarId,
                intent.eventId,
                startsAt,
                DEFAULT_EVENT_REMINDER_MINUTES,
              ),
              "confirmed_on_create",
              op.id,
              now,
              guard,
            ),
          ]
        : []),
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

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((v) => v.toLowerCase()))];
}

function sameAddresses(a: readonly string[], b: readonly string[]): boolean {
  const left = unique(a).sort();
  const right = unique(b).sort();
  return left.length === right.length && left.every((v, i) => v === right[i]);
}

/** Adding guests also emails an update to the guests already invited. */
function existingGuestsNote(intent: PatchEventIntent): string {
  const others = (intent.notify?.recipients ?? []).filter((r) => !intent.addAttendees?.includes(r));
  if (others.length === 0) return "";
  return `\nThe existing guests also get an update:\n${others.map((o) => `• ${o}`).join("\n")}`;
}

function guestsEmailed(notice: GuestNotice, what = "update"): string {
  const n = notice.recipients.length;
  return `Google emailed the ${what} to ${n} guest${n === 1 ? "" : "s"}.`;
}

/**
 * The confirmation shown before Google emails guests: the exact change and
 * every recipient. Bound to the operation by its preview hash.
 */
export function guestChangePreview(intent: PatchEventIntent): {
  text: string;
  confirmLabel: string;
  facts: unknown;
} {
  const recipients = (intent.notify?.recipients ?? []).map((r) => `• ${r}`).join("\n");
  if (intent.addAttendees?.length) {
    return {
      text: `Invite to ${intent.title}:\n${intent.addAttendees.map((a) => `• ${a}`).join("\n")}\n\nGoogle will email ${intent.addAttendees.length === 1 ? "them an invitation" : "each of them an invitation"}.${existingGuestsNote(intent)}`,
      confirmLabel: "Send invitations",
      facts: {
        eventId: intent.eventId,
        add: intent.addAttendees,
        recipients: intent.notify?.recipients ?? [],
      },
    };
  }
  const what: string[] = [];
  if (intent.patch.summary) what.push(`Rename to ${intent.patch.summary}`);
  if (intent.patch.start && intent.patch.end) {
    what.push(
      `Move to ${formatEventRange({ start: intent.patch.start, end: intent.patch.end }, "timeZone" in intent.patch.start ? intent.patch.start.timeZone : "UTC")}`,
    );
  }
  const scope = intent.scope === "series" ? " (every occurrence)" : "";
  return {
    text: `Change ${intent.title}${scope}:\n${what.join("\n")}\n\nGoogle will email the update to:\n${recipients}`,
    confirmLabel: "Send update",
    facts: {
      eventId: intent.eventId,
      patch: intent.patch,
      recipients: intent.notify?.recipients ?? [],
      scope: intent.scope ?? null,
    },
  };
}

/** "Dinner moved to 5–6pm in Calendar while your change to 4–5pm was pending. Which should I keep?" */
function conflictNotice(
  title: string,
  intent: PatchEventIntent,
  details: unknown,
  user: UserRecord,
): string {
  const current = ((details as { current?: Partial<EventFields> } | undefined)?.current ??
    {}) as Partial<EventFields>;
  const describe = (fields: Partial<EventFields>) => {
    if (fields.summary !== undefined) return `"${fields.summary}"`;
    if (fields.start && fields.end) {
      const range = formatEventRange({ start: fields.start, end: fields.end }, user.timezone);
      return range;
    }
    return "a different value";
  };
  return `${title} changed in Calendar to ${describe(current)} while your change to ${describe(intent.patch)} was pending. Nothing was overwritten. Which should I keep?`;
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
