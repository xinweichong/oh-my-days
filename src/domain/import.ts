import { capture, type Named, type TaskDue } from "./capture";
import type { LocalDate } from "./time";

/**
 * Bulk task import: several lines, each read with the quick-capture grammar
 * (spec §4), into one preview that is confirmed once. Only tasks are
 * imported; a line that isn't exactly one task is skipped with its reason,
 * never guessed at. Pure: the caller supplies lists and existing tasks.
 */

/**
 * The most tasks one import creates. Each costs two D1 statements, three when
 * its deadline is inside the reminder window, and Workers Free allows 50
 * queries per invocation; eight leave room for the request's own reads,
 * writes, and replies (measured in tests/flows/import.test.ts).
 */
export const MAX_IMPORT = 8;

export interface ImportTask {
  line: string;
  title: string;
  listId: string | null;
  due: TaskDue;
  /** "to X" named no existing list, so X stayed in the title (as in quick capture). */
  unknownList: string | null;
}

export type SkipReason =
  /** A time without `by`: quick capture would make an event. */
  | "event"
  /** A date or hour with more than one reading (e.g. today's weekday). */
  | "ambiguous"
  | "multiple"
  | "no_title"
  | "unclear"
  /** The same task as an earlier line. */
  | "repeated"
  /** An open task with this title, list, and deadline already exists. */
  | "exists";

export type ImportResult =
  | { kind: "empty" }
  | { kind: "too_many"; count: number }
  | { kind: "preview"; tasks: ImportTask[]; skipped: { line: string; reason: SkipReason }[] };

export interface ExistingTask {
  title: string;
  listId: string;
  due: TaskDue;
}

/** Bullets and numbering from a copied list: "- ", "• ", "* ", "2. ", "3) ". */
const BULLET = /^(?:[-*•]|\d{1,3}[.)])\s+/;
const TRAILING_LIST = /\s(?:to|in)\s+(.+)$/i;

export function readImport(
  text: string,
  ctx: { today: LocalDate; lists: Named[]; inboxId: string | null },
  existing: ExistingTask[],
): ImportResult {
  const lines = text
    .split("\n")
    .map((l) => l.trim().replace(BULLET, "").trim())
    .filter(Boolean);
  if (lines.length === 0) return { kind: "empty" };

  const tasks: ImportTask[] = [];
  const skipped: { line: string; reason: SkipReason }[] = [];
  const seen = new Set<string>();
  const known = new Set(existing.map((t) => taskKey(t.title, t.listId, t.due)));

  for (const line of lines) {
    // Tasks only, so calendars never apply ("on X" stays in the title).
    const result = capture(line, { today: ctx.today, lists: ctx.lists, calendars: [] });
    if (result.kind !== "create") {
      skipped.push({ line, reason: result.kind === "choose" ? "ambiguous" : result.kind });
      continue;
    }
    const { draft } = result;
    if (draft.kind !== "task") {
      skipped.push({ line, reason: "event" });
      continue;
    }
    const key = taskKey(draft.title, draft.listId ?? ctx.inboxId, draft.due);
    if (seen.has(key)) {
      skipped.push({ line, reason: "repeated" });
      continue;
    }
    seen.add(key);
    if (known.has(key)) {
      skipped.push({ line, reason: "exists" });
      continue;
    }
    const trailing = draft.listId === null ? TRAILING_LIST.exec(line) : null;
    const unknownList =
      trailing?.[1] && draft.title.toLowerCase().endsWith(trailing[0].trim().toLowerCase())
        ? trailing[1].trim()
        : null;
    tasks.push({ line, title: draft.title, listId: draft.listId, due: draft.due, unknownList });
  }
  if (tasks.length > MAX_IMPORT) return { kind: "too_many", count: tasks.length };
  return { kind: "preview", tasks, skipped };
}

/** Title (ignoring case and spacing), list, and deadline: what makes two tasks the same. */
export function taskKey(title: string, listId: string | null, due: TaskDue): string {
  const when =
    due.kind === "none" ? "" : due.kind === "date" ? due.date : `${due.date}T${due.time}`;
  return JSON.stringify([title.toLowerCase().replace(/\s+/g, " ").trim(), listId, when]);
}
