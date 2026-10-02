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
}

/** One user's calendar access. Constructed per user from that user's credentials. */
export interface CalendarPort {
  getEvent(calendarId: string, eventId: string): Promise<ProviderResult<CalendarEvent>>;
  /** Creates with a client-chosen ID so a repeated create cannot duplicate the event. */
  insertEvent(
    calendarId: string,
    eventId: string,
    fields: EventFields,
  ): Promise<ProviderResult<CalendarEvent>>;
  /** Writes only the given fields, and only if the event still has `ifMatchEtag`. */
  patchEvent(
    calendarId: string,
    eventId: string,
    patch: Partial<EventFields>,
    ifMatchEtag: string,
  ): Promise<ProviderResult<CalendarEvent>>;
  deleteEvent(
    calendarId: string,
    eventId: string,
    ifMatchEtag: string,
  ): Promise<ProviderResult<null>>;
}

/** Returns the user's calendar port, or null when no usable Google connection exists. */
export type CalendarPortFactory = (userId: string) => Promise<CalendarPort | null>;
