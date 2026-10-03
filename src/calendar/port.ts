import type { EventFields } from "../domain/calendar-event";

/**
 * Typed provider outcomes (backend plan §2). Adapters translate transport
 * errors into these; application code never sees raw provider errors.
 */
export type ProviderError =
  | { kind: "retryable"; retryAfterMs: number | null }
  | { kind: "auth_required" }
  | { kind: "forbidden" }
  | { kind: "not_found" }
  /** Version precondition failed (If-Match) or the ID already exists. */
  | { kind: "conflict" }
  | { kind: "validation_failed" }
  /** The request may or may not have taken effect. Reconcile before repeating. */
  | { kind: "outcome_unknown" };

export type ProviderResult<T> = { ok: true; value: T } | { ok: false; error: ProviderError };

export interface CalendarEvent {
  calendarId: string;
  id: string;
  /** Provider version used for conditional writes. */
  etag: string;
  status: "confirmed" | "tentative" | "cancelled";
  fields: EventFields;
  /** Set on an occurrence of a recurring series: the series (master) ID. */
  recurringEventId?: string | null;
  /** A series master (has recurrence rules). */
  recurring?: boolean;
  /** Has attendees besides the user; changing it could notify them. */
  hasGuests?: boolean;
}

/** Properties beyond the editable fields, used for task deadline markers. */
export interface EventExtras {
  /** Show as free: deadlines never reserve time. */
  transparent?: boolean;
  /** Turn off Google's own notifications (the bot sends reminders). */
  silent?: boolean;
  /** Private metadata only this app reads, e.g. the linked task ID. */
  privateProperties?: Record<string, string>;
  /** RFC 5545 rules for a recurring event, e.g. ["RRULE:FREQ=WEEKLY"]. */
  recurrence?: string[];
}

/** One user's calendar access. Constructed per user from that user's credentials. */
export interface CalendarPort {
  getEvent(calendarId: string, eventId: string): Promise<ProviderResult<CalendarEvent>>;
  /** Creates with a client-chosen ID so a repeated create cannot duplicate the event. */
  insertEvent(
    calendarId: string,
    eventId: string,
    fields: EventFields,
    extras?: EventExtras,
  ): Promise<ProviderResult<CalendarEvent>>;
  /** Writes only the given fields, and only if the event still has `ifMatchEtag`. */
  patchEvent(
    calendarId: string,
    eventId: string,
    patch: Partial<EventFields>,
    ifMatchEtag: string,
    extras?: EventExtras,
  ): Promise<ProviderResult<CalendarEvent>>;
  deleteEvent(
    calendarId: string,
    eventId: string,
    ifMatchEtag: string,
  ): Promise<ProviderResult<null>>;
}

/** Returns the user's calendar port, or null when no usable Google connection exists. */
export type CalendarPortFactory = (userId: string) => Promise<CalendarPort | null>;

export type AccessRole = "owner" | "writer" | "reader" | "freeBusyReader";

export interface CalendarListEntry {
  calendarId: string;
  summary: string;
  accessRole: AccessRole;
  primary: boolean;
}

export function isWritable(role: AccessRole): boolean {
  return role === "owner" || role === "writer";
}

/** Calendar-level access: the user's calendar list and calendars the app creates. */
export interface CalendarDirectory {
  /** The complete calendar list; fails rather than returning a partial list. */
  listCalendars(): Promise<ProviderResult<CalendarListEntry[]>>;
  createCalendar(summary: string, timeZone: string): Promise<ProviderResult<CalendarListEntry>>;
}

export type CalendarDirectoryFactory = (userId: string) => Promise<CalendarDirectory | null>;

/** An event as seen by synchronization, with the facts views and policies need. */
export interface SyncedEvent {
  id: string;
  etag: string;
  status: "confirmed" | "tentative" | "cancelled";
  /** Null for cancelled entries, which carry no reliable details. */
  fields: EventFields | null;
  /** A recurring series master (has recurrence rules). */
  recurring: boolean;
  /** Set on an instance or exception of a recurring series. */
  recurringEventId: string | null;
  /** Marked "free", e.g. task deadline markers; never a scheduling conflict. */
  transparent: boolean;
  /** The user declined this invitation. */
  declined: boolean;
  /** Has attendees other than the user; changing it could notify them. */
  hasGuests: boolean;
  /** The user organizes it (or it has no organizer distinct from the user). */
  organizerSelf: boolean;
}

export type EventPageResult =
  | {
      ok: true;
      items: SyncedEvent[];
      nextPageToken: string | null;
      /** Present on the last page; resume incremental sync with it. */
      nextSyncToken: string | null;
    }
  /** The sync token expired; a full resynchronization is required. */
  | { ok: false; reset: true }
  | { ok: false; reset?: false; error: ProviderError };

export interface CalendarSyncSource {
  /** One page of changes (with a sync token) or of all events (without one). */
  listEventPage(
    calendarId: string,
    cursor: { syncToken: string | null; pageToken: string | null },
  ): Promise<EventPageResult>;
  /** Event occurrences overlapping a time window, recurring instances expanded. */
  listWindow(
    calendarId: string,
    timeMin: number,
    timeMax: number,
  ): Promise<ProviderResult<SyncedEvent[]>>;
}
