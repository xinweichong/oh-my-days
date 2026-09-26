/**
 * Structured operational logging. Callers pass identifiers, counts, timings, and
 * error classes only — never message text, tokens, calendar data, or contacts.
 */
export type LogFields = Record<string, string | number | boolean | null | undefined>;

export function logEvent(event: string, fields: LogFields = {}): void {
  console.log(JSON.stringify({ event, ...fields }));
}
