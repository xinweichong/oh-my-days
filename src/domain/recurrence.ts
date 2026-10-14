import { addDays, isValidLocalDate, type LocalDate } from "./time";

/**
 * Fixed recurrence for tasks (spec §6), following RFC 5545 date semantics:
 * a monthly rule on the 31st skips months without one, and a yearly rule on
 * 29 February occurs only in leap years. Dates are never clamped.
 */
export type Frequency = "daily" | "weekly" | "monthly" | "yearly";

/**
 * A narrower rule: "weekdays" (with daily: Monday to Friday) or "last_day"
 * (with monthly: the last day of each month, RFC 5545 BYMONTHDAY=-1).
 */
export type RepeatBy = "weekdays" | "last_day";

export interface Recurrence {
  freq: Frequency;
  interval: number;
  /** The first occurrence; monthly and yearly rules repeat its day (and month). */
  anchor: LocalDate;
  by?: RepeatBy | null;
}

/** What the user chose, before it is anchored to a date. */
export interface RepeatChoice {
  freq: Frequency;
  interval: number;
  by?: RepeatBy | null;
}

/** Largest "every N" accepted for days, weeks, or months. */
export const MAX_INTERVAL = 99;

/** "every 2 weeks", "3 days", "every 6 months" → a choice; anything else null. */
export function parseRepeatInterval(input: string): RepeatChoice | null {
  const m = /^(?:every\s+)?(\d{1,2})\s*(day|days|week|weeks|month|months)$/i.exec(input.trim());
  if (!m) return null;
  const interval = Number(m[1]);
  if (interval < 1 || interval > MAX_INTERVAL) return null;
  const unit = (m[2] ?? "").toLowerCase();
  const freq: Frequency = unit.startsWith("day")
    ? "daily"
    : unit.startsWith("week")
      ? "weekly"
      : "monthly";
  return { freq, interval };
}

function lastDayOf(y: number, m: number): LocalDate {
  return addDays(m === 12 ? iso(y + 1, 1, 1) : iso(y, m + 1, 1), -1);
}

/** The first date on or after the anchor that the rule produces (the anchor itself for plain rules). */
export function firstOccurrence(rule: Recurrence): LocalDate | null {
  return occurrencesBetween(rule, rule.anchor, addDays(rule.anchor, 400), 1)[0] ?? null;
}

function parts(date: LocalDate): [number, number, number] {
  return date.split("-").map(Number) as [number, number, number];
}

function iso(y: number, m: number, d: number): LocalDate {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * Occurrence dates in [from, to], in order. `limit` bounds the result so a
 * long outage or a daily rule cannot produce unbounded work.
 */
export function occurrencesBetween(
  rule: Recurrence,
  from: LocalDate,
  to: LocalDate,
  limit: number,
): LocalDate[] {
  const out: LocalDate[] = [];
  const [ay, am, ad] = parts(rule.anchor);
  const start = from > rule.anchor ? from : rule.anchor;
  const step = Math.max(1, Math.floor(rule.interval));

  if (rule.by === "weekdays") {
    // Monday to Friday, every day (the interval doesn't apply).
    for (let date = start; date <= to && out.length < limit; date = addDays(date, 1)) {
      const day = new Date(`${date}T00:00:00Z`).getUTCDay();
      if (day !== 0 && day !== 6) out.push(date);
    }
    return out;
  }
  if (rule.by === "last_day") {
    const [sy, sm] = parts(start);
    let k = Math.max(0, Math.floor(((sy - ay) * 12 + (sm - am)) / step));
    for (let scanned = 0; out.length < limit && scanned < 400; k++, scanned++) {
      const total = am - 1 + k * step;
      const candidate = lastDayOf(ay + Math.floor(total / 12), (total % 12) + 1);
      if (candidate > to) break;
      if (candidate >= start) out.push(candidate);
    }
    return out;
  }

  if (rule.freq === "daily" || rule.freq === "weekly") {
    const days = rule.freq === "daily" ? step : step * 7;
    const elapsed = Math.round(
      (Date.parse(`${start}T00:00:00Z`) - Date.parse(`${rule.anchor}T00:00:00Z`)) / 86_400_000,
    );
    let date = addDays(rule.anchor, Math.ceil(elapsed / days) * days);
    while (date <= to && out.length < limit) {
      out.push(date);
      date = addDays(date, days);
    }
    return out;
  }

  // Monthly and yearly: step through periods, skipping invalid dates.
  const monthsPerStep = rule.freq === "monthly" ? step : step * 12;
  const [sy, sm] = parts(start);
  let k = Math.max(0, Math.floor(((sy - ay) * 12 + (sm - am)) / monthsPerStep));
  // At most a few hundred periods are scanned (leap-day rules skip three in four).
  for (let scanned = 0; out.length < limit && scanned < 400; k++, scanned++) {
    const total = am - 1 + k * monthsPerStep;
    const y = ay + Math.floor(total / 12);
    const m = (total % 12) + 1;
    const candidate = iso(y, m, ad);
    if (candidate > to) break;
    if (candidate >= start && isValidLocalDate(candidate)) out.push(candidate);
  }
  return out;
}

const ORDINAL = (n: number) => {
  const suffix =
    n % 10 === 1 && n !== 11
      ? "st"
      : n % 10 === 2 && n !== 12
        ? "nd"
        : n % 10 === 3 && n !== 13
          ? "rd"
          : "th";
  return `${n}${suffix}`;
};
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** The interpreted schedule, stated plainly, including any skipped dates. */
export function describeRecurrence(rule: Recurrence): string {
  if (rule.by === "weekdays") return "Every weekday (Monday to Friday)";
  if (rule.by === "last_day") {
    return rule.interval === 1
      ? "Every month on its last day"
      : `Every ${rule.interval} months on the last day`;
  }
  const [, m, d] = parts(rule.anchor);
  const weekday = WEEKDAYS[new Date(`${rule.anchor}T00:00:00Z`).getUTCDay()];
  switch (rule.freq) {
    case "daily":
      return rule.interval === 1 ? "Every day" : `Every ${rule.interval} days`;
    case "weekly":
      return rule.interval === 1
        ? `Every week on ${weekday}`
        : `Every ${rule.interval} weeks on ${weekday}`;
    case "monthly": {
      const base =
        rule.interval === 1
          ? `Every month on the ${ORDINAL(d)}`
          : `Every ${rule.interval} months on the ${ORDINAL(d)}`;
      return d > 28 ? `${base} (months without a ${ORDINAL(d)} are skipped)` : base;
    }
    case "yearly": {
      const base = `Every year on ${d} ${MONTHS[m - 1]}`;
      return m === 2 && d === 29 ? `${base} (only in leap years)` : base;
    }
  }
}

/** RRULE for a native recurring Google event with the same meaning. */
export function toRRule(choice: RepeatChoice): string {
  if (choice.by === "weekdays") return "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR";
  const name = { daily: "DAILY", weekly: "WEEKLY", monthly: "MONTHLY", yearly: "YEARLY" }[
    choice.freq
  ];
  const interval = choice.interval > 1 ? `;INTERVAL=${choice.interval}` : "";
  const last = choice.by === "last_day" ? ";BYMONTHDAY=-1" : "";
  return `RRULE:FREQ=${name}${interval}${last}`;
}
