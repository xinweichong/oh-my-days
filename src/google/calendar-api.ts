import type {
  AccessRole,
  CalendarDirectory,
  CalendarEvent,
  CalendarListEntry,
  CalendarPort,
  CalendarSyncSource,
  ProviderError,
  ProviderResult,
  SyncedEvent,
} from "../calendar/port";
import type { EventFields, EventTime } from "../domain/calendar-event";

const API = "https://www.googleapis.com/calendar/v3";
const TIMEOUT_MS = 10_000;
/** Bounds calendar-list paging; a user with more calendars than this gets an error. */
const MAX_LIST_PAGES = 5;

export type AccessTokenResult =
  | { ok: true; token: string }
  | { ok: false; reason: "auth_required" | "retryable" };

/** Supplies a valid access token; `forceRefresh` after Google rejects the current one. */
export type AccessTokenSource = (forceRefresh: boolean) => Promise<AccessTokenResult>;

type Write = "read" | "write";

export type GoogleCalendarApi = CalendarPort & CalendarDirectory & CalendarSyncSource;

/** Events per page; small enough to parse well inside the Worker CPU limit. */
const EVENT_PAGE_SIZE = "250";

/**
 * Google Calendar v3 adapter. Event writes use client-chosen IDs, ETag
 * preconditions, and sendUpdates=none (attendee notifications are a later,
 * separately confirmed feature).
 */
export function createGoogleCalendar(
  tokens: AccessTokenSource,
  fetchImpl: typeof fetch = fetch,
): GoogleCalendarApi {
  async function request<T>(
    kind: Write,
    method: string,
    path: string,
    parse: (body: unknown) => T | null,
    init: { body?: unknown; ifMatch?: string; query?: Record<string, string> } = {},
  ): Promise<ProviderResult<T>> {
    for (const forceRefresh of [false, true]) {
      const token = await tokens(forceRefresh);
      if (!token.ok) {
        return fail(token.reason === "auth_required" ? { kind: "auth_required" } : retryable(null));
      }
      const url = new URL(`${API}${path}`);
      if (init.query) url.search = new URLSearchParams(init.query).toString();
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method,
          headers: {
            authorization: `Bearer ${token.token}`,
            ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
            ...(init.ifMatch ? { "if-match": init.ifMatch } : {}),
          },
          ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch {
        // A write may have reached Google before the connection failed.
        return fail(kind === "write" ? { kind: "outcome_unknown" } : retryable(null));
      }
      // One retry with a fresh token if the cached one was rejected.
      if (response.status === 401 && !forceRefresh) continue;
      if (response.ok) {
        const body = response.status === 204 ? null : await response.json().catch(() => undefined);
        const value = parse(body);
        if (value === null) {
          return fail(kind === "write" ? { kind: "outcome_unknown" } : retryable(null));
        }
        return { ok: true, value };
      }
      return fail(await classify(response, kind));
    }
    return fail({ kind: "auth_required" });
  }

  const eventPath = (calendarId: string, eventId: string) =>
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`;

  return {
    getEvent(calendarId, eventId) {
      return request("read", "GET", eventPath(calendarId, eventId), (b) => toEvent(calendarId, b));
    },
    insertEvent(calendarId, eventId, fields) {
      return request(
        "write",
        "POST",
        `/calendars/${encodeURIComponent(calendarId)}/events`,
        (b) => toEvent(calendarId, b),
        { body: { id: eventId, ...toGoogleFields(fields) }, query: { sendUpdates: "none" } },
      );
    },
    patchEvent(calendarId, eventId, patch, ifMatchEtag) {
      return request(
        "write",
        "PATCH",
        eventPath(calendarId, eventId),
        (b) => toEvent(calendarId, b),
        {
          body: toGoogleFields(patch),
          ifMatch: ifMatchEtag,
          query: { sendUpdates: "none" },
        },
      );
    },
    deleteEvent(calendarId, eventId, ifMatchEtag) {
      return request("write", "DELETE", eventPath(calendarId, eventId), () => null as null, {
        ifMatch: ifMatchEtag,
        query: { sendUpdates: "none" },
      }).then((r) => (r.ok ? { ok: true as const, value: null } : r));
    },

    async listCalendars() {
      const entries: CalendarListEntry[] = [];
      let pageToken: string | undefined;
      for (let page = 0; page < MAX_LIST_PAGES; page++) {
        const result = await request(
          "read",
          "GET",
          "/users/me/calendarList",
          (b) => toCalendarPage(b),
          { query: { maxResults: "250", ...(pageToken ? { pageToken } : {}) } },
        );
        if (!result.ok) return result;
        entries.push(...result.value.items);
        pageToken = result.value.nextPageToken;
        if (!pageToken) return { ok: true, value: entries };
      }
      return fail({ kind: "validation_failed" });
    },

    async listEventPage(calendarId, cursor) {
      const query: Record<string, string> = { maxResults: EVENT_PAGE_SIZE, singleEvents: "false" };
      if (cursor.pageToken) query.pageToken = cursor.pageToken;
      if (cursor.syncToken) query.syncToken = cursor.syncToken;
      const path = `/calendars/${encodeURIComponent(calendarId)}/events`;
      const result = await request("read", "GET", path, toEventPage, { query });
      if (result.ok) return { ok: true, ...result.value };
      // 410 Gone: the sync token is no longer valid (mapped to not_found above).
      if (result.error.kind === "not_found" && cursor.syncToken) return { ok: false, reset: true };
      return { ok: false, error: result.error };
    },

    async listWindow(calendarId, timeMin, timeMax) {
      const items: SyncedEvent[] = [];
      let pageToken: string | null = null;
      for (let page = 0; page < MAX_LIST_PAGES; page++) {
        const query: Record<string, string> = {
          singleEvents: "true",
          orderBy: "startTime",
          maxResults: EVENT_PAGE_SIZE,
          timeMin: new Date(timeMin).toISOString(),
          timeMax: new Date(timeMax).toISOString(),
        };
        if (pageToken) query.pageToken = pageToken;
        const result = await request(
          "read",
          "GET",
          `/calendars/${encodeURIComponent(calendarId)}/events`,
          toEventPage,
          { query },
        );
        if (!result.ok) return result;
        items.push(...result.value.items);
        pageToken = result.value.nextPageToken;
        if (!pageToken) return { ok: true, value: items };
      }
      return fail({ kind: "validation_failed" });
    },

    createCalendar(summary, timeZone) {
      return request(
        "write",
        "POST",
        "/calendars",
        (b) => {
          const id = (b as { id?: unknown } | null)?.id;
          return typeof id === "string"
            ? { calendarId: id, summary, accessRole: "owner" as const, primary: false }
            : null;
        },
        { body: { summary, timeZone } },
      );
    },
  };
}

async function classify(response: Response, kind: Write): Promise<ProviderError> {
  const status = response.status;
  if (status === 429 || status >= 500) {
    const after = Number(response.headers.get("retry-after"));
    return retryable(Number.isFinite(after) && after > 0 ? after * 1000 : null);
  }
  if (status === 401) return { kind: "auth_required" };
  if (status === 403) {
    // Google reports rate limits as 403 with a rate-limit reason.
    const reason = await errorReason(response);
    return reason && /rateLimitExceeded|userRateLimitExceeded|quotaExceeded/.test(reason)
      ? retryable(null)
      : { kind: "forbidden" };
  }
  if (status === 404 || status === 410) return { kind: "not_found" };
  if (status === 409 || status === 412) return { kind: "conflict" };
  if (status === 400) return { kind: "validation_failed" };
  return kind === "write" ? { kind: "outcome_unknown" } : retryable(null);
}

async function errorReason(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { error?: { errors?: { reason?: unknown }[] } };
    const reason = body.error?.errors?.[0]?.reason;
    return typeof reason === "string" ? reason : null;
  } catch {
    return null;
  }
}

function retryable(retryAfterMs: number | null): ProviderError {
  return { kind: "retryable", retryAfterMs };
}

function fail<T>(error: ProviderError): ProviderResult<T> {
  return { ok: false, error };
}

function toGoogleFields(fields: Partial<EventFields>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (fields.summary !== undefined) out.summary = fields.summary;
  if (fields.start !== undefined) out.start = fields.start;
  if (fields.end !== undefined) out.end = fields.end;
  return out;
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null;
}

function toTime(value: unknown): EventTime | null {
  if (!isObject(value)) return null;
  if (typeof value.date === "string") return { date: value.date };
  if (typeof value.dateTime === "string") {
    // Events created elsewhere may omit timeZone; the offset in dateTime is authoritative.
    return {
      dateTime: value.dateTime,
      timeZone: typeof value.timeZone === "string" ? value.timeZone : "UTC",
    };
  }
  return null;
}

export function toEvent(calendarId: string, body: unknown): CalendarEvent | null {
  if (!isObject(body) || typeof body.id !== "string" || typeof body.etag !== "string") return null;
  const status =
    body.status === "cancelled" || body.status === "tentative" ? body.status : "confirmed";
  const start = toTime(body.start);
  const end = toTime(body.end);
  // Cancelled instances can omit times; they are only checked for liveness.
  if ((!start || !end) && status !== "cancelled") return null;
  const fallback: EventTime = { date: "1970-01-01" };
  return {
    calendarId,
    id: body.id,
    etag: body.etag,
    status,
    fields: {
      summary: typeof body.summary === "string" ? body.summary : "",
      start: start ?? fallback,
      end: end ?? fallback,
    },
  };
}

const ROLES: readonly AccessRole[] = ["owner", "writer", "reader", "freeBusyReader"];

function toCalendarPage(
  body: unknown,
): { items: CalendarListEntry[]; nextPageToken: string | undefined } | null {
  if (!isObject(body) || !Array.isArray(body.items)) return null;
  const items: CalendarListEntry[] = [];
  for (const item of body.items) {
    if (!isObject(item) || typeof item.id !== "string") continue;
    if (item.deleted === true) continue;
    const role = ROLES.find((r) => r === item.accessRole);
    if (!role) continue;
    const name =
      typeof item.summaryOverride === "string"
        ? item.summaryOverride
        : typeof item.summary === "string"
          ? item.summary
          : item.id;
    items.push({
      calendarId: item.id,
      summary: name,
      accessRole: role,
      primary: item.primary === true,
    });
  }
  return {
    items,
    nextPageToken: typeof body.nextPageToken === "string" ? body.nextPageToken : undefined,
  };
}

function toSyncedEvent(item: unknown): SyncedEvent | null {
  if (!isObject(item) || typeof item.id !== "string" || typeof item.etag !== "string") return null;
  const event = toEvent("", item);
  const status = event?.status ?? (item.status === "cancelled" ? "cancelled" : null);
  if (!status) return null;
  const attendees = Array.isArray(item.attendees) ? item.attendees.filter(isObject) : [];
  const self = attendees.find((a) => a.self === true);
  const organizer = isObject(item.organizer) ? item.organizer : null;
  return {
    id: item.id,
    etag: item.etag,
    status,
    fields: status === "cancelled" || !event ? null : event.fields,
    recurring: Array.isArray(item.recurrence) && item.recurrence.length > 0,
    recurringEventId: typeof item.recurringEventId === "string" ? item.recurringEventId : null,
    transparent: item.transparency === "transparent",
    declined: self?.responseStatus === "declined",
    hasGuests: attendees.some((a) => a.self !== true && a.resource !== true),
    organizerSelf: organizer ? organizer.self === true : true,
  };
}

function toEventPage(body: unknown): {
  items: SyncedEvent[];
  nextPageToken: string | null;
  nextSyncToken: string | null;
} | null {
  if (!isObject(body) || !Array.isArray(body.items)) return null;
  return {
    items: body.items.map(toSyncedEvent).filter((e): e is SyncedEvent => e !== null),
    nextPageToken: typeof body.nextPageToken === "string" ? body.nextPageToken : null,
    nextSyncToken: typeof body.nextSyncToken === "string" ? body.nextSyncToken : null,
  };
}
