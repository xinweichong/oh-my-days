import type { EventFields, EventTime } from "./calendar-event";
import { addDays, type LocalDate, rfc3339 } from "./time";

/**
 * Task rules independent of storage and providers. Deadlines show when work is
 * due; markers never reserve time. A date-only deadline stays a local date.
 */

export type Deadline =
  | { kind: "none" }
  | { kind: "date"; date: LocalDate }
  | { kind: "datetime"; at: number; timeZone: string };

export type TaskStatus = "open" | "completed" | "cancelled";

export interface TaskView {
  title: string;
  listName: string;
  deadline: Deadline;
  status: TaskStatus;
}

export const COMPLETION_MARK = "✓";
export const MAX_TASK_TITLE = 200;
export const MAX_LIST_NAME = 40;

/** Lists compare case- and whitespace-insensitively, so names never silently duplicate. */
export function normalizeListName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

/** `[Work] Submit expenses`, or `✓ [Work] Submit expenses` once completed. */
export function markerTitle(task: Pick<TaskView, "title" | "listName" | "status">): string {
  const done = task.status === "completed" ? `${COMPLETION_MARK} ` : "";
  return `${done}[${task.listName}] ${task.title}`;
}

export interface ParsedMarker {
  title: string;
  completed: boolean;
  /** The list named in a leading [annotation] that matches a known list. */
  listName: string | null;
}

/**
 * Reads a marker title edited in Google Calendar. A leading ✓ means completed.
 * A leading [annotation] is taken as the list only when it matches a known list;
 * otherwise it stays part of the title, so no list is created by accident.
 */
export function parseMarkerTitle(summary: string, knownLists: readonly string[]): ParsedMarker {
  let text = summary.trim();
  const completed = /^[✓✔]/.test(text);
  if (completed) text = text.replace(/^[✓✔]️?\s*/, "");
  let listName: string | null = null;
  const annotation = /^\[([^\]]{1,60})\]\s*/.exec(text);
  if (annotation) {
    const wanted = normalizeListName(annotation[1] ?? "");
    const match = knownLists.find((name) => normalizeListName(name) === wanted);
    if (match) {
      listName = match;
      text = text.slice(annotation[0].length);
    }
  }
  return { title: text.trim() || summary.trim(), completed, listName };
}

/** The marker to show in the task calendar, or null when the task should have none. */
export function desiredMarker(task: TaskView): EventFields | null {
  if (task.status === "cancelled" || task.deadline.kind === "none") return null;
  const summary = markerTitle(task);
  if (task.deadline.kind === "date") {
    return {
      summary,
      start: { date: task.deadline.date },
      end: { date: addDays(task.deadline.date, 1) },
    };
  }
  // A zero-length marker at the exact due time: it shows when work is due and
  // reserves no time (it is also marked free).
  const at: EventTime = {
    dateTime: rfc3339(task.deadline.at, task.deadline.timeZone),
    timeZone: task.deadline.timeZone,
  };
  return { summary, start: at, end: at };
}

/** The deadline a marker's start represents. */
export function deadlineFromMarker(start: EventTime): Deadline {
  if ("date" in start) return { kind: "date", date: start.date };
  return { kind: "datetime", at: Date.parse(start.dateTime), timeZone: start.timeZone };
}

export function deadlinesEqual(a: Deadline, b: Deadline): boolean {
  if (a.kind === "none" || b.kind === "none") return a.kind === b.kind;
  if (a.kind === "date" || b.kind === "date") {
    return a.kind === "date" && b.kind === "date" && a.date === b.date;
  }
  return a.at === b.at;
}
