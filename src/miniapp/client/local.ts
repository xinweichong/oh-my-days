import type { Local } from "./types";

/**
 * The user's own day and time, as the server last reported it. Days and times
 * are named in the user's zone, never the phone's, so "Tomorrow" and "7pm"
 * mean the same here as in chat.
 */

let current: Local | null = null;

export function setLocal(local: Local | undefined): void {
  if (local) current = local;
}

export function local(): Local | null {
  return current;
}

/** A local date `days` after `date` (both YYYY-MM-DD). */
export function addDays(date: string, days: number): string {
  const t = Date.parse(`${date}T00:00:00Z`) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/** Whole days from `a` to `b`. */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

function format(date: string, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat("en-GB", { ...options, timeZone: "UTC" }).format(
    new Date(`${date}T00:00:00Z`),
  );
}

/** "Thu" */
export function weekdayShort(date: string): string {
  return format(date, { weekday: "short" });
}

/** "Thursday" */
export function weekdayLong(date: string): string {
  return format(date, { weekday: "long" });
}

/** "Thu 15 Oct", as the chat writes dates. */
export function dayLabel(date: string): string {
  return `${weekdayShort(date)} ${format(date, { day: "numeric", month: "short" })}`;
}

/** "Today", "Tomorrow", or "Thu 15 Oct". */
export function relativeDay(date: string, today: string): string {
  const days = daysBetween(today, date);
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  return dayLabel(date);
}

/** Minutes since midnight for "HH:MM". */
export function minutesOf(time: string): number {
  const [h, m] = time.split(":").map(Number) as [number, number];
  return h * 60 + m;
}

/** "HH:MM" for minutes since midnight. */
export function wallTime(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** "9am", "5:36pm", as the chat writes times. */
export function clockLabel(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  const min = m % 60;
  const suffix = h < 12 ? "am" : "pm";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return min ? `${hour}:${String(min).padStart(2, "0")}${suffix}` : `${hour}${suffix}`;
}

/** "in 24 min", "in 2 hr 24 min" until an instant; null once it has passed. */
export function countdown(at: number, now: number): string | null {
  const minutes = Math.round((at - now) / 60_000);
  if (minutes <= 0) return null;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return minutes < 60 ? `in ${minutes} min` : `in ${hours} hr${rest ? ` ${rest} min` : ""}`;
}
