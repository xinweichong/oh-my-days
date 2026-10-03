import type { EventFields, EventTime } from "../domain/calendar-event";

/**
 * Formats an event's interpreted range in the user's timezone, e.g.
 * "Fri 25 Sep 2026, 7–8pm" or "Fri 25 – Sun 27 Sep 2026 (all day)".
 */
export function formatEventRange(
  fields: Pick<EventFields, "start" | "end">,
  timeZone: string,
): string {
  if ("date" in fields.start && "date" in fields.end) {
    return formatAllDayRange(fields.start.date, fields.end.date);
  }
  const start = new Date(instantOf(fields.start));
  const end = new Date(instantOf(fields.end));
  const startDay = dayLabel(start, timeZone, true);
  const endDay = dayLabel(end, timeZone, true);
  if (startDay === endDay) {
    return `${startDay}, ${timeRange(start, end, timeZone)}`;
  }
  return `${startDay}, ${clock(start, timeZone, true)} – ${dayLabel(end, timeZone, false)}, ${clock(end, timeZone, true)}`;
}

function instantOf(time: EventTime): string {
  return "dateTime" in time ? time.dateTime : `${time.date}T00:00:00Z`;
}

/** All-day end dates are exclusive, as in Google Calendar. */
function formatAllDayRange(startDate: string, endExclusive: string): string {
  const start = new Date(`${startDate}T00:00:00Z`);
  const last = new Date(Date.parse(`${endExclusive}T00:00:00Z`) - 86_400_000);
  if (last.getTime() <= start.getTime()) return `${dayLabel(start, "UTC", true)} (all day)`;
  const sameYear = start.getUTCFullYear() === last.getUTCFullYear();
  const sameMonth = sameYear && start.getUTCMonth() === last.getUTCMonth();
  const from = sameMonth
    ? parts(start, "UTC", { weekday: "short", day: "numeric" })
    : dayLabel(start, "UTC", !sameYear);
  return `${from} – ${dayLabel(last, "UTC", true)} (all day)`;
}

function dayLabel(date: Date, timeZone: string, withYear: boolean): string {
  return parts(date, timeZone, {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(withYear ? { year: "numeric" } : {}),
  });
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Builds labels from numeric calendar parts in the target zone; month and
 * weekday names are fixed here so output does not vary with ICU locale data.
 */
function parts(date: Date, timeZone: string, options: Intl.DateTimeFormatOptions): string {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "numeric",
    year: "numeric",
  }).formatToParts(date);
  const get = (type: string) => p.find((x) => x.type === type)?.value;
  const month = MONTHS[Number(get("month")) - 1];
  return [
    options.weekday ? get("weekday") : undefined,
    options.day ? get("day") : undefined,
    options.month ? month : undefined,
    options.year ? get("year") : undefined,
  ]
    .filter(Boolean)
    .join(" ");
}

function timeRange(start: Date, end: Date, timeZone: string): string {
  const sameHalf = meridiem(start, timeZone) === meridiem(end, timeZone);
  return `${clock(start, timeZone, !sameHalf)}–${clock(end, timeZone, true)}`;
}

function clock(date: Date, timeZone: string, withMeridiem: boolean): string {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(date);
  const hour = p.find((x) => x.type === "hour")?.value ?? "";
  const minute = p.find((x) => x.type === "minute")?.value ?? "00";
  const time = minute === "00" ? hour : `${hour}:${minute}`;
  return withMeridiem ? `${time}${meridiem(date, timeZone)}` : time;
}

function meridiem(date: Date, timeZone: string): "am" | "pm" {
  const p = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hour12: true })
    .formatToParts(date)
    .find((x) => x.type === "dayPeriod")?.value;
  return p?.toLowerCase() === "pm" ? "pm" : "am";
}

/** A compact start label for buttons, e.g. "Fri 9 Oct, 7pm" or "Fri 9 Oct (all day)". */
export function formatShortStart(fields: Pick<EventFields, "start">, timeZone: string): string {
  if ("date" in fields.start) {
    return `${parts(new Date(`${fields.start.date}T00:00:00Z`), "UTC", { weekday: "short", day: "numeric", month: "short" })} (all day)`;
  }
  const start = new Date(instantOf(fields.start));
  return `${parts(start, timeZone, { weekday: "short", day: "numeric", month: "short" })}, ${clock(start, timeZone, true)}`;
}

/** A date label for buttons, e.g. "Sat 3 Oct". */
export function formatDayLabel(date: string): string {
  return parts(new Date(`${date}T00:00:00Z`), "UTC", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

/** A time of day in the user's zone, e.g. "7pm" or "7:30am". */
export function formatTime(instant: number, timeZone: string): string {
  return clock(new Date(instant), timeZone, true);
}
