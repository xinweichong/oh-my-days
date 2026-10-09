import {
  type DateResult,
  type DurationInput,
  parseDate,
  parseDuration,
  parseTime,
  parseTimeRange,
  type TimeResult,
} from "./parse-input";
import type { LocalDate, WallTime } from "./time";

/**
 * Quick capture (spec §4): one plain message read with a fixed local grammar
 * into one creation, or a question. Pure and local; nothing leaves the Worker.
 * It only proposes creations; it never edits, deletes, or targets an item.
 */

export const MAX_CAPTURE_LENGTH = 200;

export interface Named {
  id: string;
  name: string;
}

export interface CaptureContext {
  today: LocalDate;
  /** The user's writable event calendars, for `on <calendar>`. */
  calendars: Named[];
  /** The user's task lists, for `to <list>` and `in <list>`. */
  lists: Named[];
}

export type TaskDue =
  | { kind: "none" }
  | { kind: "date"; date: LocalDate }
  | { kind: "datetime"; date: LocalDate; time: WallTime };

export type CaptureDraft =
  | {
      kind: "event";
      title: string;
      date: LocalDate;
      /** Null for an all-day event. */
      start: WallTime | null;
      /** Null means the default length. */
      length: DurationInput | null;
      calendarId: string | null;
    }
  | { kind: "task"; title: string; due: TaskDue; listId: string | null };

export type Capture =
  | { kind: "create"; draft: CaptureDraft }
  /** Readings to choose between: dates, am/pm, or task vs all-day event. */
  | { kind: "choose"; options: CaptureDraft[] }
  /** Several dates or times joined as separate requests: create nothing. */
  | { kind: "multiple" }
  /** A date or time but nothing to call it. */
  | { kind: "no_title" }
  /** Not readable: offer to add it as a task or event, or cancel. */
  | { kind: "unclear"; title: string };

/** Choices are offered as buttons; beyond this the message is unclear. */
const MAX_OPTIONS = 4;
/** The longest date or time phrase, in words ("from 10 pm to 1 am"). */
const MAX_SPAN = 6;

interface Token {
  /** As typed, for the title. */
  raw: string;
  /** Lowercase without surrounding punctuation, for matching. */
  word: string;
  /** Followed by a comma or semicolon. */
  joins: boolean;
}

type MatchValue =
  | { type: "date"; value: DateResult }
  | { type: "time"; value: TimeResult }
  | { type: "range"; start: WallTime; end: WallTime }
  | { type: "length"; value: DurationInput };

type Match = MatchValue & { from: number; to: number; taskSignal: boolean };

const TASK_PREFIXES = [
  ["add", "a", "task"],
  ["add", "task"],
  ["new", "task"],
  ["remind", "me", "to"],
  ["remind", "me"],
  ["task"],
  ["todo"],
  ["to-do"],
  ["to", "do"],
];

/** Words that may introduce a date without being part of the title. */
const DATE_LEADS = new Set(["on", "by", "due", "next", "this", "coming", "before"]);
/** Weekday abbreviations that are also ordinary words; they need context. */
const WORDLIKE_DAYS = new Set(["sat", "sun", "wed"]);
/** Connectors left dangling at either end of a title are dropped. */
const DANGLING = new Set(["at", "on", "by", "due", "for", "from", "to", "in", "and", "until"]);

export function capture(text: string, ctx: CaptureContext): Capture {
  const trimmed = text.trim();
  const lines = trimmed
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const firstLine = lines[0] ?? "";
  if (trimmed.length > MAX_CAPTURE_LENGTH || /^[\p{P}\p{S}\s]*$/u.test(trimmed)) {
    return { kind: "unclear", title: clip(firstLine) };
  }
  if (lines.length > 1) {
    const clusters = lines.reduce((n, line) => n + clustersOf(scan(tokenize(line), ctx)).length, 0);
    return clusters >= 2 ? { kind: "multiple" } : { kind: "unclear", title: clip(firstLine) };
  }

  const tokens = tokenize(trimmed);
  const prefix = taskPrefix(tokens);
  // A leading "add" alone ("Add dinner Fri 7pm") says nothing about the type.
  const skip = prefix === 0 && tokens[0]?.word === "add" && tokens.length > 1 ? 1 : prefix;
  const body = tokens.slice(skip);
  const matches = scan(body, ctx);
  const clusters = clustersOf(matches);
  const lengths = matches.filter((m) => m.type === "length");
  if (clusters.length >= 2) {
    return joined(body, clusters) ? { kind: "multiple" } : { kind: "unclear", title: trimmed };
  }
  if (lengths.length > 1) return { kind: "unclear", title: trimmed };

  const cluster = clusters[0] ?? [];
  const date = cluster.find((m) => m.type === "date");
  const time = cluster.find((m) => m.type === "time" || m.type === "range");
  const length = lengths[0];
  const isTask = prefix > 0 || cluster.some((m) => m.taskSignal);
  const used = new Set<number>();
  for (const m of [...cluster, ...lengths]) {
    for (let i = m.from; i < m.to; i++) used.add(i);
  }

  const dates: (LocalDate | null)[] = date?.type === "date" ? choices(date.value) : [null];
  const times: (WallTime | null)[] =
    time?.type === "time" ? choices(time.value) : time?.type === "range" ? [time.start] : [null];
  const options: CaptureDraft[] = [];
  const titled = (kind: "task" | "event") => title(body, used, kind, ctx, skip > 0);

  for (const d of dates) {
    for (const t of times) {
      if (isTask) {
        // A task has a deadline, not a length or range.
        if (length || time?.type === "range") return { kind: "unclear", title: trimmed };
        const t2 = titled("task");
        const due: TaskDue = t
          ? { kind: "datetime", date: d ?? ctx.today, time: t }
          : d
            ? { kind: "date", date: d }
            : { kind: "none" };
        options.push({ kind: "task", title: t2.title, due, listId: t2.id });
      } else if (t) {
        const e = titled("event");
        const end: DurationInput | null =
          time?.type === "range"
            ? { endTime: time.end }
            : length?.type === "length"
              ? length.value
              : null;
        options.push({
          kind: "event",
          title: e.title,
          date: d ?? ctx.today,
          start: t,
          length: end,
          calendarId: e.id,
        });
      } else if (length) {
        // A length without a start can't be placed.
        return { kind: "unclear", title: trimmed };
      } else if (d) {
        // A date alone: a task due that day, or an all-day event.
        const t2 = titled("task");
        const e = titled("event");
        options.push({
          kind: "task",
          title: t2.title,
          due: { kind: "date", date: d },
          listId: t2.id,
        });
        options.push({
          kind: "event",
          title: e.title,
          date: d,
          start: null,
          length: null,
          calendarId: e.id,
        });
      } else {
        const t2 = titled("task");
        options.push({ kind: "task", title: t2.title, due: { kind: "none" }, listId: t2.id });
      }
    }
  }

  if (options.some((o) => o.title.length === 0)) return { kind: "no_title" };
  const [only] = options;
  if (options.length === 1 && only) return { kind: "create", draft: only };
  if (options.length > MAX_OPTIONS) return { kind: "unclear", title: trimmed };
  return { kind: "choose", options };
}

function choices<T>(value: { date: T } | { time: T } | { choose: T[] }): T[] {
  if ("choose" in value) return value.choose;
  return "date" in value ? [value.date] : [value.time];
}

function clip(text: string): string {
  return text.length <= MAX_CAPTURE_LENGTH ? text : `${text.slice(0, MAX_CAPTURE_LENGTH - 1)}…`;
}

function tokenize(line: string): Token[] {
  return line
    .split(/\s+/)
    .filter(Boolean)
    .map((raw) => ({
      raw,
      word: raw
        .toLowerCase()
        .replace(/^[("'“‘]+/, "")
        .replace(/[,;:.!?)"'”’]+$/, ""),
      joins: /[,;]$/.test(raw),
    }));
}

/** The number of leading tokens that are a task prefix ("remind me to"). */
function taskPrefix(tokens: Token[]): number {
  for (const prefix of TASK_PREFIXES) {
    if (prefix.every((w, i) => tokens[i]?.word === w) && tokens.length > prefix.length) {
      return prefix.length;
    }
  }
  return 0;
}

/** Finds date, time, range, and length phrases, longest first, left to right. */
function scan(tokens: Token[], ctx: CaptureContext): Match[] {
  const matches: Match[] = [];
  let i = 0;
  while (i < tokens.length) {
    const found = longestAt(tokens, i, ctx);
    if (found) {
      matches.push(found);
      i = found.to;
    } else {
      i++;
    }
  }
  return dropWordlikeDays(tokens, matches);
}

function longestAt(tokens: Token[], i: number, ctx: CaptureContext): Match | null {
  const first = tokens[i]?.word ?? "";
  // "by"/"due" (optionally "due by"/"due on") mark a task deadline.
  let lead = 0;
  if (first === "by" || first === "due") {
    lead = tokens[i + 1]?.word === "by" || tokens[i + 1]?.word === "on" ? 2 : 1;
  }
  const start = i + lead;
  for (let n = Math.min(MAX_SPAN, tokens.length - start); n >= 1; n--) {
    const words = tokens.slice(start, start + n);
    // A phrase can't run across a comma or semicolon.
    if (words.slice(0, -1).some((t) => t.joins)) continue;
    const phrase = words.map((t) => t.word).join(" ");
    const value = read(phrase, ctx, lead > 0);
    if (value) return { ...value, from: i, to: start + n, taskSignal: lead > 0 };
  }
  return null;
}

function read(phrase: string, ctx: CaptureContext, afterDeadlineWord: boolean): MatchValue | null {
  const head = phrase.split(" ")[0] ?? "";
  if (head === "for") {
    const value = parseDuration(phrase.slice(4));
    return value && "minutes" in value ? { type: "length", value } : null;
  }
  if (head === "until" || head === "till") {
    const value = parseDuration(phrase);
    return value && "endTime" in value ? { type: "length", value } : null;
  }
  const range = parseTimeRange(phrase.replace(/^(?:at|between) /, ""));
  if (range && !afterDeadlineWord) return { type: "range", ...range };
  // A bare number is a time only after "at" ("at 3"), never "3 apples".
  const bare = /^\d{1,2}$/.test(phrase);
  if (!bare && (head === "at" || /\d|noon|midnight/.test(phrase))) {
    const time = parseTime(phrase, { askUnpaddedClock: true });
    if (time) return { type: "time", value: time };
  }
  const date = parseDate(phrase, ctx.today);
  if (date) return { type: "date", value: date };
  return null;
}

/** "sat", "sun", and "wed" count as days only after a date word or before a time. */
function dropWordlikeDays(tokens: Token[], matches: Match[]): Match[] {
  return matches.filter((m, k) => {
    if (m.type !== "date" || m.to - m.from !== 1) return true;
    if (!WORDLIKE_DAYS.has(tokens[m.from]?.word ?? "")) return true;
    const before = tokens[m.from - 1]?.word ?? "";
    const next = matches[k + 1];
    const timeFollows =
      next && next.from === m.to && (next.type === "time" || next.type === "range");
    return DATE_LEADS.has(before) || Boolean(timeFollows);
  });
}

/**
 * Groups adjacent date and time phrases into one "when" (Friday at noon,
 * 3pm tomorrow). A group holds at most one date and one time.
 */
function clustersOf(matches: Match[]): Match[][] {
  const clusters: Match[][] = [];
  // Where the previous phrase ended; a length in between doesn't separate a group.
  let end = -1;
  for (const m of matches) {
    const adjacent = end === m.from;
    end = m.to;
    if (m.type === "length") continue;
    const current = clusters.at(-1);
    if (current && adjacent && !current.some((c) => kindOf(c) === kindOf(m))) current.push(m);
    else clusters.push([m]);
  }
  return clusters;
}

function kindOf(m: Match): "date" | "time" {
  return m.type === "date" ? "date" : "time";
}

/** True when a comma, semicolon, "and", or "&" separates the groups. */
function joined(tokens: Token[], clusters: Match[][]): boolean {
  for (let k = 1; k < clusters.length; k++) {
    const prevEnd = clusters[k - 1]?.at(-1)?.to ?? 0;
    const nextStart = clusters[k]?.[0]?.from ?? 0;
    for (let i = prevEnd - 1; i < nextStart; i++) {
      const t = tokens[i];
      if (!t) continue;
      if (t.joins || t.word === "and" || t.word === "&") return true;
    }
  }
  return false;
}

/**
 * The title: the words not read as a date, time, or length, with a matching
 * `on <calendar>` (events) or `to|in <list>` (tasks) removed. Unmatched
 * phrases stay in the title.
 */
function title(
  tokens: Token[],
  used: Set<number>,
  kind: "task" | "event",
  ctx: CaptureContext,
  capitalize: boolean,
): { title: string; id: string | null } {
  const leads = kind === "event" ? ["on"] : ["to", "in"];
  const names = kind === "event" ? ctx.calendars : ctx.lists;
  let attribute: { from: number; to: number; id: string } | null = null;
  for (let i = 0; i < tokens.length; i++) {
    if (used.has(i) || !leads.includes(tokens[i]?.word ?? "")) continue;
    const found = matchName(tokens, i + 1, used, names);
    if (found) attribute = { from: i, to: found.to, id: found.id };
  }
  const kept = tokens.filter(
    (_, i) => !used.has(i) && !(attribute && i >= attribute.from && i < attribute.to),
  );
  while (kept.length && DANGLING.has(kept[0]?.word ?? "")) kept.shift();
  while (kept.length && DANGLING.has(kept.at(-1)?.word ?? "")) kept.pop();
  let text = kept
    .map((t) => t.raw)
    .join(" ")
    .replace(/^[\s,;:–—-]+|[\s,;:–—-]+$/g, "");
  if (capitalize) text = text.charAt(0).toUpperCase() + text.slice(1);
  return { title: text, id: attribute?.id ?? null };
}

/** The longest existing name starting at token `i`, compared whole-word and ignoring case. */
function matchName(
  tokens: Token[],
  i: number,
  used: Set<number>,
  names: Named[],
): { id: string; to: number } | null {
  let best: { id: string; to: number } | null = null;
  for (const named of names) {
    const words = named.name.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;
    const fits = words.every((w, k) => !used.has(i + k) && tokens[i + k]?.word === w);
    if (fits && (!best || i + words.length > best.to))
      best = { id: named.id, to: i + words.length };
  }
  return best;
}
