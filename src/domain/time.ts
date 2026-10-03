/**
 * Calendar-time arithmetic kept explicit: local dates (YYYY-MM-DD), local wall
 * times (HH:MM) in an IANA zone, and UTC instants (epoch ms) are distinct types
 * of value. Date-only values are never converted to midnight UTC.
 */

export type LocalDate = string; // YYYY-MM-DD
export type WallTime = string; // HH:MM (24-hour)

const MINUTE = 60_000;
const DAY = 86_400_000;

interface WallParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** The wall-clock reading of an instant in a zone. */
export function wallPartsAt(instant: number, timeZone: string): WallParts {
  const parts = formatterFor(timeZone).formatToParts(new Date(instant));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
  };
}

/** Offset of the zone from UTC at an instant, in minutes (e.g. +480 for Singapore). */
export function offsetMinutesAt(instant: number, timeZone: string): number {
  const w = wallPartsAt(instant, timeZone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
  const truncated = instant - (((instant % MINUTE) + MINUTE) % MINUTE);
  return Math.round((asUtc - truncated) / MINUTE);
}

export type ZonedResult =
  | { ok: true; instant: number; offsetMinutes: number }
  /** The wall time is skipped by a daylight-saving transition in this zone. */
  | { ok: false; reason: "nonexistent" };

/**
 * The instant at which a zone's clocks read the given local date and time. In a
 * fall-back overlap the earlier instant is chosen; a skipped time is rejected
 * rather than silently shifted.
 */
export function zonedInstant(date: LocalDate, time: WallTime, timeZone: string): ZonedResult {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const [hh, mm] = time.split(":").map(Number) as [number, number];
  const naive = Date.UTC(y, m - 1, d, hh, mm);
  const candidates = new Set<number>();
  for (const probe of [naive - DAY, naive, naive + DAY]) {
    candidates.add(naive - offsetMinutesAt(probe, timeZone) * MINUTE);
  }
  const matching = [...candidates]
    .filter((t) => {
      const w = wallPartsAt(t, timeZone);
      return w.year === y && w.month === m && w.day === d && w.hour === hh && w.minute === mm;
    })
    .sort((a, b) => a - b);
  const instant = matching[0];
  if (instant === undefined) return { ok: false, reason: "nonexistent" };
  return { ok: true, instant, offsetMinutes: offsetMinutesAt(instant, timeZone) };
}

/** RFC 3339 local time with offset, e.g. 2026-10-09T19:00:00+08:00. */
export function rfc3339(instant: number, timeZone: string): string {
  const w = wallPartsAt(instant, timeZone);
  const offset = offsetMinutesAt(instant, timeZone);
  const sign = offset < 0 ? "-" : "+";
  const abs = Math.abs(offset);
  return `${w.year}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}:00${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** The local date in a zone at an instant. */
export function localDateAt(instant: number, timeZone: string): LocalDate {
  const w = wallPartsAt(instant, timeZone);
  return `${w.year}-${pad(w.month)}-${pad(w.day)}`;
}

/** Calendar arithmetic on local dates, independent of any zone. */
export function addDays(date: LocalDate, days: number): LocalDate {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** 0 = Sunday … 6 = Saturday. */
export function weekday(date: LocalDate): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function isValidLocalDate(date: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return false;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
