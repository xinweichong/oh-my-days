/**
 * Provider-neutral event fields the application reads and writes. A date-only
 * value is an all-day date (end exclusive); a timed value is a local wall time
 * plus its IANA zone, never a bare UTC instant.
 */
export type EventTime = { date: string } | { dateTime: string; timeZone: string };

export interface EventFields {
  summary: string;
  start: EventTime;
  end: EventTime;
}

export type EventField = keyof EventFields;

export const EVENT_FIELDS: readonly EventField[] = ["summary", "start", "end"];

export function pickEventFields(
  fields: EventFields,
  names: readonly EventField[] = EVENT_FIELDS,
): Partial<EventFields> {
  const out: Partial<EventFields> = {};
  for (const name of names) Object.assign(out, { [name]: fields[name] });
  return out;
}
