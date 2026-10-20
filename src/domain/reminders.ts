import { parseTime, parseWhen } from "./parse-input";
import { addDays, type LocalDate, localDateAt, type WallTime, zonedInstant } from "./time";

/**
 * Per-item reminders (spec §5): several per event or task, each a lead time
 * before it, a time on a day relative to it, or a fixed time. Pure rules; the
 * caller supplies the clock, zone, and the item's time.
 */
export type ReminderRule =
  /** Minutes before a timed event or exact deadline. */
  | { kind: "before"; minutes: number }
  /** A local time on the item's day, or `days` days before it. */
  | { kind: "day"; days: number; time: WallTime }
  /** A fixed instant. */
  | { kind: "at"; at: number };

/** What reminders are measured from: a start or exact deadline, or a whole date. */
export type ReminderAnchor = { kind: "instant"; at: number } | { kind: "date"; date: LocalDate };

export const MAX_RULES = 5;
export const MAX_BEFORE_MINUTES = 7 * 24 * 60;
export const MAX_DAYS_BEFORE = 7;

const WALL = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Compact, stable codes: b60, d1@18:00, a1790000000000. Part of reminder keys. */
export function encodeRule(rule: ReminderRule): string {
  switch (rule.kind) {
    case "before":
      return `b${rule.minutes}`;
    case "day":
      return `d${rule.days}@${rule.time}`;
    case "at":
      return `a${rule.at}`;
  }
}

export function decodeRule(code: string): ReminderRule | null {
  let m = /^b(\d{1,5})$/.exec(code);
  if (m) {
    const minutes = Number(m[1]);
    return minutes <= MAX_BEFORE_MINUTES ? { kind: "before", minutes } : null;
  }
  m = /^d(\d)@(\d\d:\d\d)$/.exec(code);
  if (m) {
    const days = Number(m[1]);
    const time = m[2] ?? "";
    return days <= MAX_DAYS_BEFORE && WALL.test(time) ? { kind: "day", days, time } : null;
  }
  m = /^a(\d{1,15})$/.exec(code);
  if (m) return { kind: "at", at: Number(m[1]) };
  return null;
}

/** Decodes a stored list, dropping anything unreadable and duplicates. */
export function decodeRules(codes: readonly unknown[]): ReminderRule[] {
  const seen = new Set<string>();
  const out: ReminderRule[] = [];
  for (const code of codes) {
    if (typeof code !== "string" || seen.has(code)) continue;
    const rule = decodeRule(code);
    if (!rule) continue;
    seen.add(code);
    out.push(rule);
  }
  return out;
}

/**
 * The part of a reminder key naming the rule. A lead time keeps the bare
 * minutes so keys match those written before several reminders existed.
 */
export function ruleKeyPart(rule: ReminderRule): string {
  return rule.kind === "before" ? String(rule.minutes) : encodeRule(rule);
}

/** Whether a rule can apply to an item with this kind of time. */
export function ruleApplies(rule: ReminderRule, anchor: ReminderAnchor): boolean {
  return rule.kind !== "before" || anchor.kind === "instant";
}

/** When a rule fires for an item, or null when it can't (or the wall time is skipped). */
export function ruleTime(
  rule: ReminderRule,
  anchor: ReminderAnchor,
  timeZone: string,
): number | null {
  switch (rule.kind) {
    case "before":
      return anchor.kind === "instant" ? anchor.at - rule.minutes * 60_000 : null;
    case "day": {
      const date = anchor.kind === "instant" ? localDateAt(anchor.at, timeZone) : anchor.date;
      const at = zonedInstant(addDays(date, -rule.days), rule.time, timeZone);
      return at.ok ? at.instant : null;
    }
    case "at":
      return rule.at;
  }
}

/**
 * Reminders must come before this: an event's start or an exact deadline, or
 * the end of a date-only deadline's day (it is overdue after that).
 */
export function anchorEnd(anchor: ReminderAnchor, timeZone: string): number {
  if (anchor.kind === "instant") return anchor.at;
  const next = addDays(anchor.date, 1);
  for (const time of ["00:00", "01:00"]) {
    const at = zonedInstant(next, time, timeZone);
    if (at.ok) return at.instant;
  }
  return Date.parse(`${next}T00:00:00Z`);
}

/** Only a lead of zero ("at the time") may fall exactly at the item's time. */
function fits(rule: ReminderRule, at: number, end: number): boolean {
  return at < end || (at === end && rule.kind === "before");
}

/** The rules that fire for an item, each with its time, earliest first. */
export function reminderTimes(
  rules: readonly ReminderRule[],
  anchor: ReminderAnchor,
  timeZone: string,
): { rule: ReminderRule; at: number }[] {
  const end = anchorEnd(anchor, timeZone);
  const out: { rule: ReminderRule; at: number }[] = [];
  for (const rule of rules) {
    const at = ruleTime(rule, anchor, timeZone);
    if (at !== null && fits(rule, at, end)) out.push({ rule, at });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Default reminders: the user's lead for timed items; none for date-only deadlines. */
export function defaultRules(anchor: ReminderAnchor, defaultMinutes: number): ReminderRule[] {
  return anchor.kind === "instant" ? [{ kind: "before", minutes: defaultMinutes }] : [];
}

// --- Typed input ---------------------------------------------------------------------

/** One typed reminder, before it is applied to an item. */
export type ReminderEntry =
  | { kind: "lead"; minutes: number; source: string }
  | { kind: "day"; days: number; time: WallTime; source: string }
  | { kind: "at"; date: LocalDate; time: WallTime; source: string };

export type ParsedReminders =
  | { kind: "none" }
  | { kind: "default" }
  | { kind: "entries"; entries: ReminderEntry[] }
  /** `part` is the piece that wasn't understood. */
  | { kind: "error"; part: string; reason: "unrecognized" | "ambiguous" | "needs_time" };

const UNIT_MINUTES: Record<string, number> = {
  m: 1,
  min: 1,
  mins: 1,
  minute: 1,
  minutes: 1,
  h: 60,
  hr: 60,
  hrs: 60,
  hour: 60,
  hours: 60,
  d: 1440,
  day: 1440,
  days: 1440,
  w: 10080,
  wk: 10080,
  week: 10080,
  weeks: 10080,
};

const UNITS = "m|mins?|minutes?|h|hrs?|hours?|d|days?|w|wk|weeks?";
const AMOUNT = String.raw`(\d+|an?|half an?)\s*(${UNITS})(?![a-z])`;
/** A run of amounts ("1h 30m"), then an optional "before" and the rest. */
const LEAD = new RegExp(
  String.raw`^((?:(?:\d+|an?|half an?)\s*(?:${UNITS})(?![a-z])\s*)+)(?:(?:before|earlier|ahead|prior)(?![a-z]))?\s*(?:at\s+)?(.*)$`,
);

/** "1h30m", "2 hours", "half an hour", "a day": minutes, or null. */
function duration(text: string): number | null {
  if (!new RegExp(String.raw`^(?:${AMOUNT}\s*)+$`).test(text)) return null;
  let total = 0;
  for (const m of text.matchAll(new RegExp(AMOUNT, "g"))) {
    const amount = m[1] ?? "";
    const unit = UNIT_MINUTES[m[2] ?? ""] ?? 0;
    const n = /^\d+$/.test(amount) ? Number(amount) : amount.startsWith("half") ? 0.5 : 1;
    total += n * unit;
  }
  return Number.isInteger(total) && total > 0 ? total : null;
}

type TimeOf = { time: WallTime } | "ambiguous" | null;

function timeOf(text: string): TimeOf {
  const result = parseTime(text.replace(/^at\s+/, ""));
  if (!result) return null;
  return "time" in result ? { time: result.time } : "ambiguous";
}

/** Splits "6pm the day before" or "the day before at 6pm" into a relative day and a time. */
function relativeDay(text: string): { days: number; rest: string } | null {
  // "Before" phrases first: "the day before" also contains "day".
  const phrases: [RegExp, number | "n"][] = [
    [/(?:^|\s)(\d+|an?|one|two|three) days? before(?:\s|$)/, "n"],
    [/(?:^|\s)(?:the )?(?:day|night|evening) before(?:\s|$)/, 1],
    [
      /(?:^|\s)(?:on the day|on that day|that day|same day|the same day|the day of|day of)(?:\s|$)/,
      0,
    ],
  ];
  for (const [pattern, days] of phrases) {
    const m = pattern.exec(text);
    if (!m) continue;
    let n = 0;
    if (days === "n") {
      const word = m[1] ?? "";
      n = /^\d+$/.test(word)
        ? Number(word)
        : ({ a: 1, an: 1, one: 1, two: 2, three: 3 }[word] ?? -1);
    } else {
      n = days;
    }
    const rest = `${text.slice(0, m.index)} ${text.slice(m.index + m[0].length)}`.trim();
    return { days: n, rest };
  }
  return null;
}

function entry(part: string, today: LocalDate): ReminderEntry | ParsedReminders {
  const text = part
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/^(?:remind me|reminders?|remind)\s*:?\s*/, "")
    .replace(/[.!]$/, "")
    .trim();
  const error = (reason: "unrecognized" | "ambiguous" | "needs_time") =>
    ({ kind: "error", part: part.trim(), reason }) as const;
  if (/^(?:at the time|when it starts|on time|at the start)$/.test(text)) {
    return { kind: "lead", minutes: 0, source: part.trim() };
  }

  // "2 hours before", "1d", "1 day before at 6pm", "2 days before 9am".
  const lead = LEAD.exec(text);
  const minutes = lead ? duration((lead[1] ?? "").trim()) : null;
  if (lead && minutes !== null) {
    const rest = (lead[2] ?? "").trim();
    if (!rest) return { kind: "lead", minutes, source: part.trim() };
    const time = timeOf(rest);
    if (time === "ambiguous") return error("ambiguous");
    if (time && minutes % 1440 === 0) {
      return { kind: "day", days: minutes / 1440, time: time.time, source: part.trim() };
    }
  }

  // "the day before at 6pm", "9am on the day", "6pm the night before".
  const relative = relativeDay(text);
  if (relative) {
    if (relative.days < 0 || relative.days > MAX_DAYS_BEFORE) return error("unrecognized");
    if (!relative.rest) return error("needs_time");
    const time = timeOf(relative.rest);
    if (time === "ambiguous") return error("ambiguous");
    if (!time) return error("unrecognized");
    return { kind: "day", days: relative.days, time: time.time, source: part.trim() };
  }

  // A time alone is on the item's day; with a date it is a fixed time.
  const time = timeOf(text);
  if (time === "ambiguous") return error("ambiguous");
  if (time) return { kind: "day", days: 0, time: time.time, source: part.trim() };
  const when = parseWhen(text.replace(/^on\s+/, ""), today);
  if (!when) return error("unrecognized");
  if (when.length > 1) return error("ambiguous");
  const [only] = when;
  if (!only?.date) return error("unrecognized");
  if (!only.time) return error("needs_time");
  return { kind: "at", date: only.date, time: only.time, source: part.trim() };
}

/**
 * Typed reminders, several separated by commas or "and": "1 day before 6pm,
 * 2h", "30m and 10m", "Thu 9am", "9am on the day". "none" clears them and
 * "default" goes back to the usual reminder.
 */
export function parseReminders(input: string, today: LocalDate): ParsedReminders {
  const text = input
    .trim()
    .replace(/^(?:remind me|reminders?|remind)\s*:?\s*/i, "")
    .trim();
  if (/^(?:none|no reminders?|off|never|don'?t remind me|clear)\.?$/i.test(text)) {
    return { kind: "none" };
  }
  if (/^(?:default|the default|usual|as usual|reset)\.?$/i.test(text)) return { kind: "default" };
  const parts = text
    .split(/\s*(?:,|;|\band\b|&)\s*/i)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return { kind: "error", part: input.trim(), reason: "unrecognized" };
  const entries: ReminderEntry[] = [];
  for (const part of parts) {
    const parsed = entry(part, today);
    if ("source" in parsed) entries.push(parsed);
    else return parsed;
  }
  return { kind: "entries", entries };
}

export type ResolveProblem = "passed" | "after" | "needs_time" | "too_early" | "time_skipped";

/**
 * Turns typed entries into rules for one item. Entries that can't apply (the
 * time has passed, or falls at or after the item) are reported, not dropped
 * silently. A whole-day lead on a date-only deadline is on that day at the
 * agenda hour.
 */
export function resolveEntries(
  entries: readonly ReminderEntry[],
  anchor: ReminderAnchor,
  context: { now: number; timeZone: string; agendaHour: number },
): { rules: ReminderRule[]; problems: { source: string; problem: ResolveProblem }[] } {
  const rules: ReminderRule[] = [];
  const problems: { source: string; problem: ResolveProblem }[] = [];
  const hour = `${String(context.agendaHour).padStart(2, "0")}:00`;
  for (const e of entries) {
    let rule: ReminderRule;
    if (e.kind === "lead") {
      if (anchor.kind === "instant") {
        if (e.minutes > MAX_BEFORE_MINUTES) {
          problems.push({ source: e.source, problem: "too_early" });
          continue;
        }
        rule = { kind: "before", minutes: e.minutes };
      } else if (e.minutes % 1440 === 0 && e.minutes > 0) {
        rule = { kind: "day", days: e.minutes / 1440, time: hour };
      } else {
        problems.push({ source: e.source, problem: "needs_time" });
        continue;
      }
    } else if (e.kind === "day") {
      rule = { kind: "day", days: e.days, time: e.time };
    } else {
      const at = zonedInstant(e.date, e.time, context.timeZone);
      if (!at.ok) {
        problems.push({ source: e.source, problem: "time_skipped" });
        continue;
      }
      rule = { kind: "at", at: at.instant };
    }
    if (rule.kind === "day" && rule.days > MAX_DAYS_BEFORE) {
      problems.push({ source: e.source, problem: "too_early" });
      continue;
    }
    const problem = checkRule(rule, anchor, context);
    if (problem) problems.push({ source: e.source, problem });
    else rules.push(rule);
  }
  return { rules, problems };
}

/** Why a rule can't be added to an item now, or null when it can. */
export function checkRule(
  rule: ReminderRule,
  anchor: ReminderAnchor,
  context: { now: number; timeZone: string },
): ResolveProblem | null {
  if (!ruleApplies(rule, anchor)) return "needs_time";
  const at = ruleTime(rule, anchor, context.timeZone);
  if (at === null) return "time_skipped";
  if (!fits(rule, at, anchorEnd(anchor, context.timeZone))) return "after";
  if (at <= context.now) return "passed";
  return null;
}

/** Adds rules to a set without duplicates, keeping at most MAX_RULES. */
export function mergeRules(
  current: readonly ReminderRule[],
  added: readonly ReminderRule[],
): { rules: ReminderRule[]; overflow: number } {
  const out = [...current];
  const codes = new Set(out.map(encodeRule));
  let overflow = 0;
  for (const rule of added) {
    const code = encodeRule(rule);
    if (codes.has(code)) continue;
    if (out.length >= MAX_RULES) {
      overflow++;
      continue;
    }
    codes.add(code);
    out.push(rule);
  }
  return { rules: out, overflow };
}
