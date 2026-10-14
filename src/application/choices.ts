import type { When } from "../domain/parse-input";
import { addDays, type LocalDate, weekday } from "../domain/time";
import { formatDayLabel, formatWallTime } from "../telegram/format";

/**
 * Labels and questions for ambiguous typed dates and times, so every flow asks
 * the same way: "Which Friday?" with dated buttons, or "3am or 3pm?".
 */

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "Today · Fri 9 Oct", "Tomorrow · Sat 10 Oct", "Fri 16 Oct". */
export function dateChoiceLabel(date: LocalDate, today: LocalDate): string {
  const prefix = date === today ? "Today · " : date === addDays(today, 1) ? "Tomorrow · " : "";
  return `${prefix}${formatDayLabel(date)}`;
}

export function whenLabel(when: When, today: LocalDate): string {
  const day = when.date ? dateChoiceLabel(when.date, today) : null;
  const time = when.time ? formatWallTime(when.time) : null;
  return [day, time].filter(Boolean).join(", ");
}

/** "Which Friday?", "3am or 3pm?", or "Which one?" for mixed choices. */
export function whenQuestion(options: When[]): string {
  const dates = new Set(options.map((o) => o.date));
  const times = new Set(options.map((o) => o.time));
  if (times.size === 1 && dates.size > 1) {
    const days = new Set([...dates].map((d) => (d ? weekday(d) : -1)));
    const [only] = [...days];
    return days.size === 1 && only !== undefined && only >= 0
      ? `Which ${DAY_NAMES[only]}?`
      : "Which day?";
  }
  if (dates.size === 1 && times.size > 1) {
    return `${[...times].map((t) => (t ? formatWallTime(t) : "")).join(" or ")}?`;
  }
  return "Which one?";
}
