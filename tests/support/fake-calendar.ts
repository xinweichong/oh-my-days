import type {
  CalendarEvent,
  CalendarPort,
  ProviderError,
  ProviderResult,
} from "../../src/calendar/port";
import type { EventFields } from "../../src/domain/calendar-event";

type Method = "get" | "insert" | "patch" | "delete";

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
export class FakeCalendar implements CalendarPort {
  readonly events = new Map<string, CalendarEvent>();
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

  seed(calendarId: string, id: string, fields: EventFields): CalendarEvent {
    const event: CalendarEvent = {
      calendarId,
      id,
      etag: this.nextEtag(),
      status: "confirmed",
      fields: structuredClone(fields),
    };
    this.events.set(key(calendarId, id), event);
    return event;
  }

  /** An edit made directly in Google Calendar. */
  externalEdit(calendarId: string, id: string, patch: Partial<EventFields>): void {
    const event = this.require(calendarId, id);
    event.fields = { ...event.fields, ...structuredClone(patch) };
    event.etag = this.nextEtag();
  }

  externalDelete(calendarId: string, id: string): void {
    const event = this.require(calendarId, id);
    event.status = "cancelled";
    event.etag = this.nextEtag();
  }

  live(calendarId: string, id: string): CalendarEvent | null {
    const event = this.events.get(key(calendarId, id));
    return event && event.status !== "cancelled" ? event : null;
  }

  async getEvent(calendarId: string, eventId: string): Promise<ProviderResult<CalendarEvent>> {
    return this.run("get", () => {
      const event = this.events.get(key(calendarId, eventId));
      return event ? ok(structuredClone(event)) : err({ kind: "not_found" });
    });
  }

  async insertEvent(
    calendarId: string,
    eventId: string,
    fields: EventFields,
  ): Promise<ProviderResult<CalendarEvent>> {
    return this.run("insert", () => {
      if (this.readOnlyCalendars.has(calendarId)) return err({ kind: "forbidden" });
      if (this.events.has(key(calendarId, eventId))) return err({ kind: "conflict" });
      return ok(structuredClone(this.seed(calendarId, eventId, fields)));
    });
  }

  async patchEvent(
    calendarId: string,
    eventId: string,
    patch: Partial<EventFields>,
    ifMatchEtag: string,
  ): Promise<ProviderResult<CalendarEvent>> {
    return this.run("patch", () => {
      if (this.readOnlyCalendars.has(calendarId)) return err({ kind: "forbidden" });
      const event = this.events.get(key(calendarId, eventId));
      if (!event) return err({ kind: "not_found" });
      if (event.etag !== ifMatchEtag) return err({ kind: "conflict" });
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
