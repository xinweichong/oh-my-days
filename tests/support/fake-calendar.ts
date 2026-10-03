import type {
  CalendarEvent,
  CalendarPort,
  CalendarSyncSource,
  EventExtras,
  EventPageResult,
  ProviderError,
  ProviderResult,
  SyncedEvent,
} from "../../src/calendar/port";
import type { EventFields } from "../../src/domain/calendar-event";

type Method = "get" | "insert" | "patch" | "delete" | "list";

/** Attributes the sync engine reads beyond the editable fields. */
export interface EventMeta {
  recurring?: boolean;
  recurringEventId?: string | null;
  transparent?: boolean;
  declined?: boolean;
  hasGuests?: boolean;
  organizerSelf?: boolean;
}

/**
 * Fault modes for crash and timeout testing:
 * - error: the provider rejects the call without applying it.
 * - apply_then_unknown: the change is applied but the response is lost.
 * - apply_then_throw: the change is applied, then the worker crashes.
 */
type Fault =
  | { method: Method; mode: "error"; error: ProviderError }
  | { method: Method; mode: "apply_then_unknown" | "apply_then_throw" };

export class WorkerCrash extends Error {
  override name = "WorkerCrash";
}

/**
 * In-memory Calendar with Google-like semantics: client-chosen IDs, ETags,
 * If-Match preconditions, and deleted events kept as cancelled.
 */
export class FakeCalendar implements CalendarPort, CalendarSyncSource {
  readonly events = new Map<string, CalendarEvent>();
  readonly meta = new Map<string, EventMeta>();
  /** Marker properties written with events (transparency, silence, private data). */
  readonly extras = new Map<string, EventExtras>();
  /** Version at which each event last changed, for incremental sync. */
  private readonly changedAt = new Map<string, number>();
  /** Bumping the epoch invalidates every issued sync token. */
  private tokenEpoch = 0;
  pageSize = 250;
  /** Calendars whose listing fails as if access was lost. */
  readonly inaccessible = new Set<string>();
  readonly calls: Method[] = [];
  readonly readOnlyCalendars = new Set<string>();
  private readonly faults: Fault[] = [];
  private version = 0;

  inject(fault: Fault): this {
    this.faults.push(fault);
    return this;
  }

  writes(): number {
    return this.calls.filter((c) => c !== "get").length;
  }

  seed(calendarId: string, id: string, fields: EventFields, meta: EventMeta = {}): CalendarEvent {
    const event: CalendarEvent = {
      calendarId,
      id,
      etag: this.nextEtag(),
      status: "confirmed",
      fields: structuredClone(fields),
    };
    this.events.set(key(calendarId, id), event);
    this.meta.set(key(calendarId, id), meta);
    this.touch(calendarId, id);
    return event;
  }

  invalidateSyncTokens(): void {
    this.tokenEpoch++;
  }

  async listEventPage(
    calendarId: string,
    cursor: { syncToken: string | null; pageToken: string | null },
  ): Promise<EventPageResult> {
    this.calls.push("list");
    if (this.inaccessible.has(calendarId)) return { ok: false, error: { kind: "not_found" } };
    const fault = this.takeFault("list");
    if (fault?.mode === "error") return { ok: false, error: fault.error };

    // Page tokens carry the query: the change baseline and the offset.
    let since: number | null;
    let offset = 0;
    if (cursor.pageToken) {
      const parsed = JSON.parse(cursor.pageToken) as { since: number | null; offset: number };
      since = parsed.since;
      offset = parsed.offset;
    } else if (cursor.syncToken) {
      const [epoch, version] = cursor.syncToken.split(":").map(Number);
      if (epoch !== this.tokenEpoch) return { ok: false, reset: true };
      since = version ?? 0;
    } else {
      since = null;
    }

    const all = [...this.events.entries()]
      .filter(([k, e]) => e.calendarId === calendarId && k.startsWith(`${calendarId}/`))
      .filter(([k, e]) =>
        since === null ? e.status !== "cancelled" : (this.changedAt.get(k) ?? 0) > since,
      )
      .sort(([a], [b]) => (a < b ? -1 : 1));
    const page = all.slice(offset, offset + this.pageSize);
    const more = offset + this.pageSize < all.length;
    return {
      ok: true,
      items: page.map(([k, e]) => this.synced(k, e)),
      nextPageToken: more ? JSON.stringify({ since, offset: offset + this.pageSize }) : null,
      nextSyncToken: more ? null : `${this.tokenEpoch}:${this.version}`,
    };
  }

  async listWindow(
    calendarId: string,
    timeMin: number,
    timeMax: number,
  ): Promise<ProviderResult<SyncedEvent[]>> {
    this.calls.push("list");
    if (this.inaccessible.has(calendarId)) return { ok: false, error: { kind: "not_found" } };
    const instant = (t: EventFields["start"]) =>
      "dateTime" in t ? Date.parse(t.dateTime) : Date.parse(`${t.date}T00:00:00Z`);
    // Like singleEvents=true: occurrences only, never series masters.
    const items = [...this.events.entries()]
      .filter(([k]) => !this.meta.get(k)?.recurring)
      .filter(([, e]) => e.calendarId === calendarId && e.status !== "cancelled")
      .filter(([, e]) => instant(e.fields.start) < timeMax && instant(e.fields.end) > timeMin)
      .map(([k, e]) => this.synced(k, e));
    return { ok: true, value: items };
  }

  private synced(k: string, e: CalendarEvent): SyncedEvent {
    const meta = this.meta.get(k) ?? {};
    const cancelled = e.status === "cancelled";
    return {
      id: e.id,
      etag: e.etag,
      status: e.status,
      fields: cancelled ? null : structuredClone(e.fields),
      recurring: meta.recurring ?? false,
      recurringEventId: meta.recurringEventId ?? null,
      transparent: meta.transparent ?? false,
      declined: meta.declined ?? false,
      hasGuests: meta.hasGuests ?? false,
      organizerSelf: meta.organizerSelf ?? true,
    };
  }

  private touch(calendarId: string, id: string): void {
    this.changedAt.set(key(calendarId, id), this.version);
  }

  private takeFault(method: Method): Fault | undefined {
    const index = this.faults.findIndex((f) => f.method === method);
    if (index === -1) return undefined;
    return this.faults.splice(index, 1)[0];
  }

  /** An edit made directly in Google Calendar. */
  externalEdit(calendarId: string, id: string, patch: Partial<EventFields>): void {
    const event = this.require(calendarId, id);
    event.fields = { ...event.fields, ...structuredClone(patch) };
    event.etag = this.nextEtag();
    this.touch(calendarId, id);
  }

  externalDelete(calendarId: string, id: string): void {
    const event = this.require(calendarId, id);
    event.status = "cancelled";
    event.etag = this.nextEtag();
    this.touch(calendarId, id);
  }

  live(calendarId: string, id: string): CalendarEvent | null {
    const event = this.events.get(key(calendarId, id));
    return event && event.status !== "cancelled" ? event : null;
  }

  async getEvent(calendarId: string, eventId: string): Promise<ProviderResult<CalendarEvent>> {
    return this.run("get", () => {
      const k = key(calendarId, eventId);
      const event = this.events.get(k);
      if (!event) return err({ kind: "not_found" });
      const meta = this.meta.get(k) ?? {};
      return ok({
        ...structuredClone(event),
        recurringEventId: meta.recurringEventId ?? null,
        recurring: meta.recurring ?? false,
        hasGuests: meta.hasGuests ?? false,
      });
    });
  }

  async insertEvent(
    calendarId: string,
    eventId: string,
    fields: EventFields,
    extras?: EventExtras,
  ): Promise<ProviderResult<CalendarEvent>> {
    return this.run("insert", () => {
      if (this.readOnlyCalendars.has(calendarId)) return err({ kind: "forbidden" });
      if (this.events.has(key(calendarId, eventId))) return err({ kind: "conflict" });
      this.extras.set(key(calendarId, eventId), extras ?? {});
      return ok(
        structuredClone(
          this.seed(calendarId, eventId, fields, {
            transparent: extras?.transparent ?? false,
            recurring: (extras?.recurrence?.length ?? 0) > 0,
          }),
        ),
      );
    });
  }

  async patchEvent(
    calendarId: string,
    eventId: string,
    patch: Partial<EventFields>,
    ifMatchEtag: string,
    extras?: EventExtras,
  ): Promise<ProviderResult<CalendarEvent>> {
    return this.run("patch", () => {
      if (this.readOnlyCalendars.has(calendarId)) return err({ kind: "forbidden" });
      const event = this.events.get(key(calendarId, eventId));
      if (!event) return err({ kind: "not_found" });
      if (event.etag !== ifMatchEtag) return err({ kind: "conflict" });
      if (extras) {
        const k = key(calendarId, eventId);
        this.extras.set(k, { ...this.extras.get(k), ...extras });
        if (extras.transparent !== undefined) {
          this.meta.set(k, { ...this.meta.get(k), transparent: extras.transparent });
        }
      }
      this.externalEdit(calendarId, eventId, patch);
      return ok(structuredClone(event));
    });
  }

  async deleteEvent(
    calendarId: string,
    eventId: string,
    ifMatchEtag: string,
  ): Promise<ProviderResult<null>> {
    return this.run("delete", () => {
      if (this.readOnlyCalendars.has(calendarId)) return err({ kind: "forbidden" });
      const event = this.events.get(key(calendarId, eventId));
      if (!event || event.status === "cancelled") return err({ kind: "not_found" });
      if (event.etag !== ifMatchEtag) return err({ kind: "conflict" });
      this.externalDelete(calendarId, eventId);
      return ok(null);
    });
  }

  private run<T>(method: Method, apply: () => ProviderResult<T>): ProviderResult<T> {
    this.calls.push(method);
    const index = this.faults.findIndex((f) => f.method === method);
    if (index === -1) return apply();
    const [fault] = this.faults.splice(index, 1);
    if (!fault) return apply();
    if (fault.mode === "error") return err(fault.error);
    apply();
    if (fault.mode === "apply_then_throw") throw new WorkerCrash();
    return err({ kind: "outcome_unknown" });
  }

  private require(calendarId: string, id: string): CalendarEvent {
    const event = this.events.get(key(calendarId, id));
    if (!event) throw new Error("fixture event missing");
    return event;
  }

  private nextEtag(): string {
    this.version++;
    return `"${this.version}"`;
  }
}

function key(calendarId: string, id: string): string {
  return `${calendarId}/${id}`;
}

function ok<T>(value: T): ProviderResult<T> {
  return { ok: true, value };
}

function err<T>(error: ProviderError): ProviderResult<T> {
  return { ok: false, error };
}
