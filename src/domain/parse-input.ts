import { addDays, isValidLocalDate, type LocalDate, type WallTime, weekday } from "./time";

/**
 * Deterministic parsing for typed dates, times, and durations: the single
 * grammar for guided input, follow-ups, and quick capture. It accepts a small,
 * documented set of forms; anything else is refused so the bot can ask again
 * rather than guess. Day-first numeric dates (9/10 = 9 October) follow the
 * Singapore/UK convention. Weeks run Monday to Sunday.
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

/** A date, or the dated choices to ask between ("Which Friday?"). */
export type DateResult = { date: LocalDate } | { choose: LocalDate[] };

/** Weekday words, Monday = 0. */
const WEEKDAYS: readonly (readonly string[])[] = [
  ["mon", "monday"],
  ["tue", "tues", "tuesday"],
  ["wed", "weds", "wednesday"],
  ["thu", "thur", "thurs", "thursday"],
  ["fri", "friday"],
  ["sat", "saturday"],
  ["sun", "sunday"],
];

/** Monday = 0 … Sunday = 6, or null if the word isn't a weekday. */
export function weekdayIndex(word: string): number | null {
  const index = WEEKDAYS.findIndex((names) => names.includes(word.toLowerCase()));
  return index === -1 ? null : index;
}

function mondayIndex(date: LocalDate): number {
  return (weekday(date) + 6) % 7;
}

/** Monday of the week containing `date`. */
export function startOfWeek(date: LocalDate): LocalDate {
  return addDays(date, -mondayIndex(date));
}

const NUMBER_WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
];

/** "3", "a", "an", "three" → 3, 1, 1, 3. */
function count(word: string): number | null {
  if (/^\d{1,3}$/.test(word)) return Number(word);
  if (word === "a" || word === "an") return 1;
  const index = NUMBER_WORDS.indexOf(word);
  return index === -1 ? null : index;
}

/** Relative offsets are limited to about a year. */
const MAX_OFFSET_DAYS = 366;

/**
 * Accepts: today, tonight, tomorrow, 2026-10-09, 9 Oct, 9 October 2026, Oct 9,
 * 9/10, 9/10/2026, a weekday (fri, Friday), next/this fri, in 3 days, in 2
 * weeks, next week (its Monday), end of month (eom), and a weekday before an
 * explicit date (Fri 9 Oct, refused if they disagree).
 *
 * A bare weekday is its next occurrence after today; on that weekday itself
 * the answer is a choice between today and a week later. "next fri" is a choice
 * when the coming Friday and next week's Friday differ. "this fri" is the one in
 * the current week, refused once past.
 */
export function parseDate(input: string, today: LocalDate): DateResult | null {
  const text = input
    .toLowerCase()
    .replace(/[,.]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^on /, "");
  if (text === "today" || text === "tonight") return { date: today };
  if (text === "tomorrow" || text === "tmr" || text === "tmrw") return { date: addDays(today, 1) };
  if (text === "next week") return { date: addDays(startOfWeek(today), 7) };
  if (/^(?:eom|end of (?:the |this )?month)$/.test(text)) {
    const [y, m] = today.split("-").map(Number) as [number, number];
    const next = m === 12 ? iso(y + 1, 1, 1) : iso(y, m + 1, 1);
    return next ? { date: addDays(next, -1) } : null;
  }

  let m = /^in (\S+) (day|days|week|weeks)$/.exec(text);
  if (m) {
    const n = count(m[1] ?? "");
    if (n === null || n < 1) return null;
    const days = n * (m[2]?.startsWith("week") ? 7 : 1);
    return days <= MAX_OFFSET_DAYS ? { date: addDays(today, days) } : null;
  }

  m = /^(?:(this|next|coming) )?([a-z]+)$/.exec(text);
  const day = m ? weekdayIndex(m[2] ?? "") : null;
  if (m && day !== null) {
    const ahead = (day - mondayIndex(today) + 7) % 7;
    const coming = addDays(today, ahead === 0 ? 7 : ahead);
    switch (m[1]) {
      case "this": {
        const date = addDays(startOfWeek(today), day);
        return date >= today ? { date } : null;
      }
      case "next": {
        const nextWeek = addDays(startOfWeek(today), 7 + day);
        return nextWeek === coming ? { date: coming } : { choose: [coming, nextWeek] };
      }
      default:
        return ahead === 0 ? { choose: [today, coming] } : { date: coming };
    }
  }

  // A weekday before an explicit date must agree with it.
  m = /^([a-z]+) (.+)$/.exec(text);
  const named = m ? weekdayIndex(m[1] ?? "") : null;
  if (m && named !== null) {
    const date = explicitDate(m[2] ?? "", today);
    return date && mondayIndex(date) === named ? { date } : null;
  }

  const date = explicitDate(text, today);
  return date ? { date } : null;
}

/** The unambiguous result of `parseDate`, or null (including when it would ask). */
export function parseLocalDate(input: string, today: LocalDate): LocalDate | null {
  const result = parseDate(input, today);
  return result && "date" in result ? result.date : null;
}

function explicitDate(text: string, today: LocalDate): LocalDate | null {
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (m) return iso(Number(m[1]), Number(m[2]), Number(m[3]));

  m = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?$/.exec(text);
  if (m) {
    const [day, month] = [Number(m[1]), Number(m[2])];
    return m[3] ? iso(Number(m[3]), month, day) : upcoming(today, month, day);
  }

  m = /^(\d{1,2})(?:st|nd|rd|th)? ([a-z]+)(?: (\d{4}))?$/.exec(text);
  if (m) {
    const month = monthIndex(m[2] ?? "");
    if (!month || !isMonthWord(m[2] ?? "")) return null;
    return m[3] ? iso(Number(m[3]), month, Number(m[1])) : upcoming(today, month, Number(m[1]));
  }

  m = /^([a-z]+) (\d{1,2})(?:st|nd|rd|th)?(?: (\d{4}))?$/.exec(text);
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

/** A time, or the am/pm choice to ask between ("3am or 3pm?"). */
export type TimeResult = { time: WallTime } | { choose: WallTime[] };

export interface TimeOptions {
  /**
   * Treat an unpadded 1–11 o'clock with minutes and no am/pm (3:30) as a
   * choice. Guided input keeps reading it as a 24-hour time.
   */
  askUnpaddedClock?: boolean;
}

/**
 * `parseWallTime`, optionally after "at", plus a bare hour (3, at 3), which is
 * never guessed: it returns the am and pm choices.
 */
export function parseTime(input: string, options: TimeOptions = {}): TimeResult | null {
  const text = input
    .trim()
    .toLowerCase()
    .replace(/^at\s+/, "");
  let m = /^(\d{1,2})$/.exec(text);
  if (m) return meridiemChoice(Number(m[1]), 0);
  m = /^([1-9])[:.](\d{2})$/.exec(text);
  if (m && options.askUnpaddedClock) return meridiemChoice(Number(m[1]), Number(m[2]));
  const time = parseWallTime(text);
  return time ? { time } : null;
}

function meridiemChoice(hour: number, minute: number): TimeResult | null {
  if (hour < 1 || hour > 12 || minute > 59) return null;
  const am = wall(hour % 12, minute);
  const pm = wall((hour % 12) + 12, minute);
  return am && pm ? { choose: hour === 12 ? [pm, am] : [am, pm] } : null;
}

interface ClockPart {
  hour: number;
  minute: number;
  meridiem: "am" | "pm" | null;
}

function clockPart(text: string): ClockPart | null {
  if (text === "noon") return { hour: 12, minute: 0, meridiem: "pm" };
  if (text === "midnight") return { hour: 12, minute: 0, meridiem: "am" };
  const m = /^(\d{1,2})(?:[:.](\d{2}))?(am|pm)?$/.exec(text);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2] ?? "0");
  if (minute > 59 || hour > 23) return null;
  const meridiem = (m[3] as "am" | "pm" | undefined) ?? null;
  if (meridiem && (hour < 1 || hour > 12)) return null;
  // Without am/pm, a bare hour needs the other side's am/pm; 24-hour needs minutes.
  if (!meridiem && m[2] === undefined && hour > 12) return null;
  return { hour, minute, meridiem };
}

function candidates(part: ClockPart): WallTime[] {
  if (part.meridiem) {
    return [wall((part.hour % 12) + (part.meridiem === "pm" ? 12 : 0), part.minute) ?? ""];
  }
  if (part.hour > 12 || part.hour === 0) return [wall(part.hour, part.minute) ?? ""];
  return [wall(part.hour % 12, part.minute) ?? "", wall((part.hour % 12) + 12, part.minute) ?? ""];
}

/**
 * Accepts a time range: 7-9pm, 7:30–9pm, 7pm to 9pm, 19:00–21:00, 11am-1pm,
 * from 10pm to 1am. A side without am/pm takes the reading that keeps the range
 * short (7-9pm is 19:00–21:00). An end at or before the start is the next day.
 * Without any am/pm, both sides must be 24-hour times with minutes.
 */
export function parseTimeRange(input: string): { start: WallTime; end: WallTime } | null {
  const text = input
    .trim()
    .toLowerCase()
    .replace(/^from\s+/, "");
  const m = /^(.+?)\s*(?:-|–|—|\bto\b|\buntil\b|\btill\b)\s*(.+)$/.exec(text);
  if (!m) return null;
  const left = clockPart((m[1] ?? "").replace(/\s+/g, ""));
  const right = clockPart((m[2] ?? "").replace(/\s+/g, ""));
  if (!left || !right) return null;

  if (!left.meridiem && !right.meridiem) {
    const fixed = /^\d{1,2}[:.]\d{2}$/;
    if (!fixed.test((m[1] ?? "").trim()) || !fixed.test((m[2] ?? "").trim())) return null;
    const start = wall(left.hour, left.minute);
    const end = wall(right.hour, right.minute);
    return start && end && start !== end ? { start, end } : null;
  }

  const starts = candidates(left);
  const ends = candidates(right);
  let start: WallTime | undefined;
  let end: WallTime | undefined;
  if (starts.length === 1) {
    start = starts[0];
    // The earliest end after the start; otherwise the morning (overnight).
    end = ends.find((e) => e > (start ?? "")) ?? ends[0];
  } else {
    end = ends[0];
    // The latest start before the end; otherwise the evening (overnight).
    start = [...starts].reverse().find((s) => s < (end ?? "")) ?? starts.at(-1);
  }
  if (!start || !end || start === end) return null;
  return { start, end };
}

export type DurationInput = { minutes: number } | { endTime: WallTime };

/**
 * Accepts a duration (30m, 45 min, 1h, 1h30, 1.5h, 2 hours, two hours, an
 * hour, half an hour) or an end time (21:00, 9pm, until 9pm). Durations are
 * limited to one week.
 */
export function parseDuration(input: string): DurationInput | null {
  const text = input.trim().toLowerCase();
  const end = parseWallTime(text.replace(/^(until|till|to)\s+/, ""));
  if (end) return { endTime: end };
  if (text === "half an hour") return { minutes: 30 };
  const words = /^(\S+)\s+(hours?|minutes?|mins?)$/.exec(text);
  const n = words ? count(words[1] ?? "") : null;
  if (words && n !== null && !/^\d/.test(words[1] ?? "")) {
    return bounded(words[2]?.startsWith("h") ? n * 60 : n);
  }

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

/** A date and/or a time of day; null parts are left unchanged by the caller. */
export interface When {
  date: LocalDate | null;
  time: WallTime | null;
}

/** At most this many date × time combinations are offered as choices. */
const MAX_WHEN_CHOICES = 4;

/**
 * A date, a time, or both in either order: "4pm", "Friday", "tomorrow 4pm",
 * "Fri at 4pm", "4pm next Friday", "9 Oct 16:00". Returns every reading: one
 * when unambiguous, several to ask between, null when unrecognized.
 */
export function parseWhen(input: string, today: LocalDate): When[] | null {
  const text = input.trim().replace(/\s+/g, " ").replace(/ at /gi, " ");
  const time = parseTime(text);
  if (time) return combinations(null, time);
  const date = parseDate(text, today);
  if (date) return combinations(date, null);
  const words = text.split(" ");
  for (let i = 1; i < words.length; i++) {
    const head = words.slice(0, i).join(" ");
    const tail = words.slice(i).join(" ");
    const headDate = parseDate(head, today);
    const tailTime = headDate ? parseTime(tail) : null;
    if (headDate && tailTime) return combinations(headDate, tailTime);
    const tailDate = parseDate(tail, today);
    const headTime = tailDate ? parseTime(head) : null;
    if (tailDate && headTime) return combinations(tailDate, headTime);
  }
  return null;
}

function combinations(date: DateResult | null, time: TimeResult | null): When[] | null {
  const dates = date ? ("date" in date ? [date.date] : date.choose) : [null];
  const times = time ? ("time" in time ? [time.time] : time.choose) : [null];
  const options = dates.flatMap((d) => times.map((t) => ({ date: d, time: t })));
  return options.length <= MAX_WHEN_CHOICES ? options : null;
}
