import { addDays, isValidLocalDate, type LocalDate, type WallTime } from "./time";

/**
 * Deterministic parsing for guided input. These accept a small, documented set
 * of forms; anything else is refused so the bot can ask again rather than guess.
 * Day-first numeric dates (9/10 = 9 October) follow the Singapore/UK convention.
 */

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function monthIndex(word: string): number | null {
  const index = MONTHS.indexOf(word.slice(0, 3).toLowerCase());
  return index === -1 ? null : index + 1;
}

function iso(y: number, m: number, d: number): LocalDate | null {
  const value = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return isValidLocalDate(value) ? value : null;
}

/**
 * The next occurrence of month/day on or after `today` when no year is given;
 * 29 February resolves to the next leap year.
 */
function upcoming(today: LocalDate, m: number, d: number): LocalDate | null {
  const year = Number(today.slice(0, 4));
  for (let offset = 0; offset <= 8; offset++) {
    const candidate = iso(year + offset, m, d);
    if (candidate && candidate >= today) return candidate;
  }
  return null;
}

/**
 * Accepts: today, tomorrow, 2026-10-09, 9 Oct, 9 October 2026, Oct 9, 9/10,
 * 9/10/2026. Returns null for anything else.
 */
export function parseLocalDate(input: string, today: LocalDate): LocalDate | null {
  const text = input.trim().toLowerCase().replace(/,/g, " ").replace(/\s+/g, " ");
  if (text === "today") return today;
  if (text === "tomorrow") return addDays(today, 1);

  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (m) return iso(Number(m[1]), Number(m[2]), Number(m[3]));

  m = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?$/.exec(text);
  if (m) {
    const [day, month] = [Number(m[1]), Number(m[2])];
    return m[3] ? iso(Number(m[3]), month, day) : upcoming(today, month, day);
  }

  m = /^(\d{1,2}) ([a-z]+)(?: (\d{4}))?$/.exec(text);
  if (m) {
    const month = monthIndex(m[2] ?? "");
    if (!month || !isMonthWord(m[2] ?? "")) return null;
    return m[3] ? iso(Number(m[3]), month, Number(m[1])) : upcoming(today, month, Number(m[1]));
  }

  m = /^([a-z]+) (\d{1,2})(?: (\d{4}))?$/.exec(text);
  if (m) {
    const month = monthIndex(m[1] ?? "");
    if (!month || !isMonthWord(m[1] ?? "")) return null;
    return m[3] ? iso(Number(m[3]), month, Number(m[2])) : upcoming(today, month, Number(m[2]));
  }
  return null;
}

const MONTH_NAMES = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

/** "oct", "octo", "october" are months; "octopus" is not. */
function isMonthWord(word: string): boolean {
  return word.length >= 3 && MONTH_NAMES.some((name) => name.startsWith(word));
}

/** Accepts: 19:00, 7:30, 7pm, 7:30pm, 7.30 pm, noon, midnight. */
export function parseWallTime(input: string): WallTime | null {
  const text = input.trim().toLowerCase().replace(/\s+/g, "");
  if (text === "noon") return "12:00";
  if (text === "midnight") return "00:00";
  let m = /^(\d{1,2})[:.](\d{2})$/.exec(text);
  if (m) return wall(Number(m[1]), Number(m[2]));
  m = /^(\d{1,2})(?:[:.](\d{2}))?(am|pm)$/.exec(text);
  if (m) {
    const hour = Number(m[1]);
    if (hour < 1 || hour > 12) return null;
    const h24 = (hour % 12) + (m[3] === "pm" ? 12 : 0);
    return wall(h24, Number(m[2] ?? "0"));
  }
  return null;
}

function wall(h: number, min: number): WallTime | null {
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

export type DurationInput = { minutes: number } | { endTime: WallTime };

/**
 * Accepts a duration (30m, 45 min, 1h, 1h30, 1.5h, 2 hours) or an end time
 * (21:00, 9pm, until 9pm). Durations are limited to one week.
 */
export function parseDuration(input: string): DurationInput | null {
  const text = input.trim().toLowerCase();
  const end = parseWallTime(text.replace(/^(until|till|to)\s+/, ""));
  if (end) return { endTime: end };

  const compact = text.replace(/\s+/g, "");
  let m = /^(\d+(?:\.\d+)?)(h|hr|hrs|hour|hours)$/.exec(compact);
  if (m) return bounded(Math.round(Number(m[1]) * 60));
  m = /^(\d+)(m|min|mins|minute|minutes)$/.exec(compact);
  if (m) return bounded(Number(m[1]));
  m = /^(\d+)h(\d{1,2})(m|min|mins)?$/.exec(compact);
  if (m && Number(m[2]) < 60) return bounded(Number(m[1]) * 60 + Number(m[2]));
  return null;
}

function bounded(minutes: number): DurationInput | null {
  return minutes > 0 && minutes <= 7 * 24 * 60 ? { minutes } : null;
}
