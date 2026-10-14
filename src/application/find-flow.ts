import { searchCachedEvents } from "../storage/events";
import { listStoredCalendars } from "../storage/google";
import {
  clearPendingInputStatement,
  type PendingInput,
  type UiAction,
} from "../storage/interactions";
import { searchOpenTasks } from "../storage/tasks";
import type { UserRecord } from "../storage/users";
import type { InlineKeyboardButton } from "../telegram/api";
import { formatShortStart } from "../telegram/format";
import type { InboundCallback, InboundMessage } from "../telegram/update";
import { type SourceFor, viewCalendars } from "./calendar-view";
import { guidedPrompt } from "./cancel";
import { ActionButtons, combine, message, type Reaction } from "./reactions";
import type { SetupDeps } from "./setup";
import { taskLabel } from "./task-flow";
import { answer, keyboardMessage, removeButtons } from "./ui";

/**
 * /find <words>: open tasks and synced one-off events whose title contains the
 * words, plus recurring events found by a live Google search when reachable.
 * Each result opens the usual task or event card. Read-only.
 */

export interface FindDeps extends SetupDeps {
  sourceFor: SourceFor;
}

export const MAX_RESULTS = 20;
const PAGE_SIZE = 8;
const MAX_QUERY = 100;
/** How far ahead the live search looks for recurring events. */
const RECURRING_AHEAD_MS = 366 * 24 * 60 * 60_000;

/** A result as stored behind the paging buttons. */
type Hit =
  | { kind: "task"; taskId: string; label: string }
  | { kind: "event"; calendarId: string; eventId: string; label: string };

export async function findCommand(
  deps: FindDeps,
  user: UserRecord,
  input: InboundMessage,
): Promise<Reaction> {
  if (user.setupStep !== "done") {
    return message(user.privateChatId, "Finish setup first: send /start to continue.");
  }
  const words = (input.text ?? "").replace(/^\/find(@\w+)?/i, "").trim();
  if (!words) {
    return guidedPrompt(deps, user, "find_query", {}, "What should I look for? Send a few words.");
  }
  return search(deps, user, words);
}

export async function handleFindInput(
  deps: FindDeps,
  user: UserRecord,
  input: InboundMessage,
  _pending: PendingInput,
): Promise<Reaction> {
  const words = (input.text ?? "").trim();
  return combine(
    { replies: [], statements: (db) => [clearPendingInputStatement(db, user.id)] },
    await search(deps, user, words),
  );
}

async function search(deps: FindDeps, user: UserRecord, words: string): Promise<Reaction> {
  if (words.length === 0 || words.length > MAX_QUERY) {
    return message(user.privateChatId, `Send up to ${MAX_QUERY} characters to look for.`);
  }
  const now = deps.clock.now();
  const calendars = viewCalendars(user, await listStoredCalendars(deps.db, user.id));
  const [tasks, events] = await Promise.all([
    searchOpenTasks(deps.db, user.id, words, MAX_RESULTS),
    searchCachedEvents(
      deps.db,
      user.id,
      calendars.map((c) => c.calendarId),
      words,
      now,
      MAX_RESULTS,
    ),
  ]);
  const hits: Hit[] = [
    ...tasks.map(
      (t): Hit => ({ kind: "task", taskId: t.id, label: `Task · ${taskLabel(t, user, true)}` }),
    ),
    ...events.map(
      (e): Hit => ({
        kind: "event",
        calendarId: e.calendarId,
        eventId: e.eventId,
        label: `${formatShortStart(e.fields, user.timezone)} · ${e.fields.summary}`,
      }),
    ),
  ];

  // Recurring events aren't in the synced copy as occurrences: ask Google.
  let recurringChecked = true;
  const source = await deps.sourceFor(user.id);
  if (!source) recurringChecked = calendars.length === 0;
  for (const calendar of source ? calendars : []) {
    if (hits.length >= MAX_RESULTS) break;
    const listed = await source?.listWindow(calendar.calendarId, now, now + RECURRING_AHEAD_MS, {
      query: words,
    });
    if (!listed?.ok) {
      recurringChecked = false;
      continue;
    }
    const seen = new Set<string>();
    for (const item of listed.value) {
      if (!item.recurringEventId || !item.fields || item.status === "cancelled" || item.declined)
        continue;
      // One line per series: its next occurrence.
      if (seen.has(item.recurringEventId)) continue;
      seen.add(item.recurringEventId);
      hits.push({
        kind: "event",
        calendarId: calendar.calendarId,
        eventId: item.id,
        label: `Repeats · next ${formatShortStart(item.fields, user.timezone)} · ${item.fields.summary}`,
      });
    }
  }

  const shown = hits.slice(0, MAX_RESULTS);
  const note = recurringChecked
    ? ""
    : "\nGoogle Calendar couldn't be reached, so recurring events weren't searched.";
  if (shown.length === 0) {
    return message(user.privateChatId, `Nothing found for "${words}".${note}`);
  }
  return page(deps, user, words, shown, 0, note, null);
}

function page(
  deps: FindDeps,
  user: UserRecord,
  words: string,
  hits: Hit[],
  index: number,
  note: string,
  editMessageId: number | null,
): Reaction {
  const buttons = new ActionButtons(deps.ids, user.id, deps.clock.now());
  const rows: InlineKeyboardButton[][] = hits
    .slice(index * PAGE_SIZE, (index + 1) * PAGE_SIZE)
    .map((h) => [
      h.kind === "task"
        ? buttons.button(truncate(h.label), "task_pick", { taskId: h.taskId })
        : buttons.button(truncate(h.label), "event_pick", {
            calendarId: h.calendarId,
            eventId: h.eventId,
          }),
    ]);
  const nav: InlineKeyboardButton[] = [];
  const more = { words, hits, note };
  if (index > 0) nav.push(buttons.button("Previous", "find_page", { ...more, page: index - 1 }));
  if ((index + 1) * PAGE_SIZE < hits.length) {
    nav.push(buttons.button("More", "find_page", { ...more, page: index + 1 }));
  }
  if (nav.length) rows.push(nav);
  const count = hits.length === 1 ? "1 result" : `${hits.length} results`;
  return {
    replies: [
      keyboardMessage(
        user,
        `${count} for "${words}".${note}`,
        { inline_keyboard: rows },
        editMessageId,
      ),
    ],
    statements: (db, guard) => buttons.statements(db, guard),
  };
}

function truncate(text: string): string {
  return text.length <= 60 ? text : `${text.slice(0, 59)}…`;
}

export function isFindAction(action: string): boolean {
  return action === "find_page";
}

export async function handleFindAction(
  deps: FindDeps,
  user: UserRecord,
  callback: InboundCallback,
  { payload }: UiAction,
): Promise<Reaction> {
  const hits = Array.isArray(payload.hits) ? (payload.hits as Hit[]) : [];
  if (hits.length === 0) return combine(answer(callback), removeButtons(user, callback));
  return combine(
    answer(callback),
    page(
      deps,
      user,
      String(payload.words ?? ""),
      hits,
      Number(payload.page ?? 0),
      String(payload.note ?? ""),
      callback.messageId,
    ),
  );
}
