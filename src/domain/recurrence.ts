import { addDays, isValidLocalDate, type LocalDate } from "./time";

/**
 * Fixed recurrence for tasks (spec §6), following RFC 5545 date semantics:
 * a monthly rule on the 31st skips months without one, and a yearly rule on
 * 29 February occurs only in leap years. Dates are never clamped.
 */
export type Frequency = "daily" | "weekly" | "monthly" | "yearly";

export interface Recurrence {
  freq: Frequency;
  interval: number;
  /** The first occurrence; monthly and yearly rules repeat its day (and month). */
  anchor: LocalDate;
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
export function toRRule(freq: Frequency, interval = 1): string {
  const name = { daily: "DAILY", weekly: "WEEKLY", monthly: "MONTHLY", yearly: "YEARLY" }[freq];
  return interval > 1 ? `RRULE:FREQ=${name};INTERVAL=${interval}` : `RRULE:FREQ=${name}`;
}
