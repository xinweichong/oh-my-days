import { renderDay, tasksForDay } from "../application/calendar-view";
import { ActionButtons } from "../application/reactions";
import {
  eventTargetKey,
  type PlannedEvent,
  type PlannedReminder,
  planReminders,
} from "../application/reminder-plan";
import { dueLabel } from "../application/task-flow";
import { dayButtons } from "../application/view-flow";
import type { CalendarPort, CalendarSyncSource } from "../calendar/port";
import type { EventFields } from "../domain/calendar-event";
import type { ReminderAnchor, ReminderRule } from "../domain/reminders";
import {
  agendaKind,
  eveningDueDate,
  nextAgendaAt,
  nextEveningAt,
  quietWindow,
  reminderKeys,
} from "../domain/schedule";
import { addDays, localDateAt } from "../domain/time";
import type { Clock } from "../shared/clock";
import type { IdGenerator } from "../shared/ids";
import { logEvent } from "../shared/log";
import { fits, type RunBudget, UNIT_COSTS } from "../shared/run-budget";
import { findCachedEvents } from "../storage/events";
import { unguarded } from "../storage/guard";
import { enqueueStatement } from "../storage/outbox";
import {
  agendaClaimGuard,
  agendaSent,
  allClaimedGuard,
  allReminderSettings,
  claimAgendaStatement,
  claimReminderStatement,
  horizonEvents,
  loggedReminderKeys,
  reanchorStatement,
} from "../storage/reminders";
import { nextSnoozeEnd, reminderCandidateTasks, type TaskRecord } from "../storage/tasks";
import {
  findUserById,
  setNextDueStatement,
  type UserRecord,
  usersDueForReminders,
} from "../storage/users";
import type { InlineKeyboardButton } from "../telegram/api";
import { formatDayLabel, formatEventRange, formatTime } from "../telegram/format";

/** A reminder this late counts as missed: it joins a single catch-up summary. */
export const LATE_AFTER_MS = 10 * 60_000;
/** Snooze reminders older than this are not sent at all. */
const SNOOZE_STALE_MS = 24 * 60 * 60_000;
/** Item reminders older than this are not sent at all (the log keeps keys for 30 days). */
const STALE_REMINDER_MS = 7 * 24 * 60 * 60_000;
/**
 * Reminders handled per user per tick. Each is a D1 claim, and Workers Free
 * allows 50 queries per invocation, so a backlog (after downtime, or many items
 * due at once) goes out over consecutive minutes rather than failing the tick.
 */
export const MAX_DUE_PER_PASS = 8;
/** Bounds Google reads for revalidation per user per tick. */
const MAX_REVALIDATIONS = 5;

export interface ReminderDeps {
  db: D1Database;
  clock: Clock;
  ids: IdGenerator;
  /** Live reads for agendas and event revalidation. */
  sourceFor: (userId: string) => Promise<ReminderSource | null>;
  /** The Mini App, offered under the agenda (null where it can't open). */
  appUrl?: string | null;
  /** The invocation's budget (ADR 0009); absent where the work has its own bounds. */
  budget?: RunBudget | undefined;
}

export type ReminderSource = CalendarSyncSource & Pick<CalendarPort, "getEvent">;

interface Due {
  key: string;
  /** Other reminders of the same item due at the same moment, claimed together. */
  alsoKeys: string[];
  dueAt: number;
  kind: "event" | "task" | "snooze";
  line: string;
  /** For events: what to revalidate, and the message. */
  event?: PlannedEvent & { text: string };
  task?: TaskRecord;
  /** The rule that fired (not for snoozes). */
  rule?: ReminderRule;
}

/**
 * An idle user is visited at least this often even when nothing is scheduled,
 * so a missed invalidation can delay a reminder by at most this long.
 */
export const MAX_IDLE_MS = 60 * 60_000;

/**
 * Sends due agendas and reminders for up to `limit` users whose next due time
 * has passed, then records each one's next due time (improvement B4).
 */
export async function runReminders(deps: ReminderDeps, limit: number): Promise<number> {
  let sent = 0;
  for (const { id, dueVersion } of await usersDueForReminders(deps.db, deps.clock.now(), limit)) {
    // A user left for lack of budget keeps their past due time: first in the next run.
    if (!fits(deps.budget, UNIT_COSTS.reminderPass)) break;
    const user = await findUserById(deps.db, id);
    if (!user) continue;
    sent += (await sendAgenda(deps, user)) ? 1 : 0;
    sent += (await sendEveningPreview(deps, user)) ? 1 : 0;
    const reminders = await sendReminders(deps, user);
    sent += reminders.sent;
    const next = await nextDue(deps, user, reminders.next);
    await setNextDueStatement(deps.db, user.id, next, dueVersion).run();
  }
  return sent;
}

/** The earliest of the next agenda, reminder, and snooze end, capped at an hour. */
async function nextDue(
  deps: ReminderDeps,
  user: UserRecord,
  nextReminder: number | null,
): Promise<number> {
  const now = deps.clock.now();
  const today = localDateAt(now, user.timezone);
  const covered = await agendaSent(deps.db, user.id, today);
  const evening =
    user.eveningHour === null
      ? null
      : nextEveningAt(
          now,
          user.timezone,
          await agendaSent(deps.db, user.id, eveningKey(today)),
          user.eveningHour,
        );
  const candidates = [
    now + MAX_IDLE_MS,
    evening ?? Number.POSITIVE_INFINITY,
    nextAgendaAt(now, user.timezone, covered, user.agendaHour),
    nextReminder ?? Number.POSITIVE_INFINITY,
    (await nextSnoozeEnd(deps.db, user.id, now)) ?? Number.POSITIVE_INFINITY,
  ];
  return Math.min(...candidates);
}

/**
 * One combined agenda per local date, sent at the user's agenda time (8am by
 * default) or on the first tick after.
 * Late after downtime (spec §8): from noon only the rest of the day, and from
 * 8pm none, with the date recorded as covered. Keyed by local date, so a
 * timezone change cannot produce a second agenda for a date already covered.
 */
async function sendAgenda(deps: ReminderDeps, user: UserRecord): Promise<boolean> {
  const now = deps.clock.now();
  const due = agendaKind(now, user.timezone, user.agendaHour);
  if (!due || (await agendaSent(deps.db, user.id, due.date))) return false;
  const { date } = due;
  if (due.kind === "skip") {
    await claimAgendaStatement(deps.db, user.id, date, `skipped:${deps.ids.next()}`, now).run();
    logEvent("agenda.skipped", { userId: user.id, date });
    return false;
  }
  const catchUp = due.kind === "catch_up";
  const { text } = await renderDay({ db: deps.db, sourceFor: deps.sourceFor }, user, date, now, {
    heading: catchUp ? "Catch-up: today so far." : "Here's your day.",
    includeSnoozed: false,
    remainingOnly: catchUp,
  });
  const claim = deps.ids.next();
  const guard = agendaClaimGuard(user.id, date, claim);
  // Tasks whose snooze just ended appear in this agenda; their separate snooze
  // reminder would duplicate it, so it is recorded as covered here.
  const listed = await tasksForDay(deps.db, user, date, now, false);
  const coveredSnoozes = [...listed.due, ...listed.overdue]
    .filter((t) => t.snoozedUntil !== null && t.snoozedUntil <= now)
    .map((t) => reminderKeys.snooze(t.id, t.snoozedUntil as number));
  const buttons = new ActionButtons(deps.ids, user.id, now);
  const keyboard = dayButtons(buttons, listed, user, deps.appUrl ?? null);
  const results = await deps.db.batch([
    claimAgendaStatement(deps.db, user.id, date, claim, now),
    ...coveredSnoozes.map((key) =>
      claimReminderStatement(deps.db, user.id, key, "summarized", claim, now, guard),
    ),
    ...buttons.statements(deps.db, guard),
    enqueueStatement(
      deps.db,
      deps.ids,
      user.id,
      {
        logicalKey: `agenda:${date}`,
        call: {
          method: "sendMessage",
          params: {
            chat_id: user.privateChatId,
            text,
            reply_markup: { inline_keyboard: keyboard },
          },
        },
      },
      now,
      guard,
    ),
  ]);
  const won = results[0]?.meta.changes === 1;
  if (won) logEvent("agenda.queued", { userId: user.id, date });
  return won;
}

/** Evening previews share agenda_runs under their own key per local date. */
function eveningKey(date: string): string {
  return `evening:${date}`;
}

/** The optional evening "Tomorrow" message (spec §7), at most once per date. */
async function sendEveningPreview(deps: ReminderDeps, user: UserRecord): Promise<boolean> {
  const now = deps.clock.now();
  const date = eveningDueDate(now, user.timezone, user.eveningHour);
  if (!date) return false;
  const key = eveningKey(date);
  if (await agendaSent(deps.db, user.id, key)) return false;
  const tomorrow = addDays(date, 1);
  const { text } = await renderDay(
    { db: deps.db, sourceFor: deps.sourceFor },
    user,
    tomorrow,
    now,
    {
      heading: "Tomorrow",
      includeSnoozed: false,
    },
  );
  const claim = deps.ids.next();
  const guard = agendaClaimGuard(user.id, key, claim);
  const buttons = new ActionButtons(deps.ids, user.id, now);
  const results = await deps.db.batch([
    claimAgendaStatement(deps.db, user.id, key, claim, now),
    ...buttons.statements(deps.db, guard),
    enqueueStatement(
      deps.db,
      deps.ids,
      user.id,
      {
        logicalKey: `evening:${date}`,
        call: {
          method: "sendMessage",
          params: {
            chat_id: user.privateChatId,
            text,
            reply_markup: {
              inline_keyboard: [[buttons.button("View week", "view_week", {})]],
            },
          },
        },
      },
      now,
      guard,
    ),
  ]);
  const won = results[0]?.meta.changes === 1;
  if (won) logEvent("evening.queued", { userId: user.id, date });
  return won;
}

function minutesLabel(minutes: number): string {
  if (minutes === 0) return "Now";
  if (minutes % 1440 === 0) return minutes === 1440 ? "In 1 day" : `In ${minutes / 1440} days`;
  if (minutes % 60 === 0) return minutes === 60 ? "In 1 hour" : `In ${minutes / 60} hours`;
  return `In ${minutes} minutes`;
}

/** An event reminder with where it is, the call link, and Open in Calendar. */
function eventReminder(event: NonNullable<Due["event"]>): {
  text: string;
  keyboard: InlineKeyboardButton[][];
} {
  const { location, callUrl, htmlLink } = event.display;
  const lines = [event.text];
  if (location) lines.push(`Where: ${location}`);
  if (callUrl) lines.push(`Video call: ${callUrl}`);
  const row: InlineKeyboardButton[] = [];
  if (callUrl) row.push({ text: "Join call", url: callUrl });
  if (htmlLink) row.push({ text: "Open in Calendar", url: htmlLink });
  return { text: lines.join("\n"), keyboard: row.length ? [row] : [] };
}

/** "In 1 hour" for a lead time; otherwise a plain reminder. */
function heading(rule: ReminderRule): string {
  return rule.kind === "before" ? minutesLabel(rule.minutes) : "Reminder";
}

/** The when-line of an event reminder, from its start and end when known. */
function eventWhen(
  fields: Pick<EventFields, "start" | "end"> | null,
  anchor: ReminderAnchor,
  timeZone: string,
): string {
  if (fields) return formatEventRange(fields, timeZone);
  if (anchor.kind === "date") return formatDayLabel(anchor.date);
  return `${formatDayLabel(localDateAt(anchor.at, timeZone))}, ${formatTime(anchor.at, timeZone)}`;
}

function eventDue(planned: PlannedReminder, event: PlannedEvent, timeZone: string): Due {
  const range = eventWhen(event.fields, event.anchor, timeZone);
  return {
    key: planned.key,
    alsoKeys: [],
    dueAt: planned.at,
    kind: "event",
    rule: planned.rule,
    line: `${event.summary} · ${range}`,
    event: {
      ...event,
      text: `${heading(planned.rule)}: ${event.summary}\n${range}`,
    },
  };
}

/** Reminders due now (not yet handled), and when the next one falls due. */
async function collectDue(
  deps: ReminderDeps,
  user: UserRecord,
  now: number,
): Promise<{ due: Due[]; next: number | null }> {
  const due: Due[] = [];
  let next: number | null = null;
  const later = (at: number) => {
    next = next === null ? at : Math.min(next, at);
  };
  const [settings, horizon, tasks] = await Promise.all([
    allReminderSettings(deps.db, user.id),
    horizonEvents(deps.db, user.id, now, now + 7 * 86_400_000),
    reminderCandidateTasks(deps.db, user.id, now, SNOOZE_STALE_MS),
  ]);

  for (const task of tasks) {
    if (
      task.snoozedUntil !== null &&
      task.snoozedUntil <= now &&
      task.snoozedUntil > now - SNOOZE_STALE_MS
    ) {
      due.push({
        key: reminderKeys.snooze(task.id, task.snoozedUntil),
        alsoKeys: [],
        dueAt: task.snoozedUntil,
        kind: "snooze",
        task,
        line: `[${task.listName}] ${task.title} · ${dueLabel(task.deadline, user.timezone)}`,
      });
    }
  }

  const ready: PlannedReminder[] = [];
  for (const planned of planReminders({ user, now, settings, horizon, tasks })) {
    if (planned.at > now) {
      later(planned.at);
      continue;
    }
    // Already past when the item's reminders were set, or too old to be useful.
    if (planned.setAt !== null && planned.at < planned.setAt) continue;
    if (now - planned.at > STALE_REMINDER_MS) continue;
    ready.push(planned);
  }
  // Events known only by their kept start: titles and times from the synced copy, in one read.
  const unlisted = ready.flatMap((p) =>
    p.event && !p.event.fromHorizon ? [eventTargetKey(p.event.calendarId, p.event.eventId)] : [],
  );
  const cached = await findCachedEvents(deps.db, user.id, unlisted);
  for (const planned of ready) {
    if (planned.event) {
      const known = planned.event.fromHorizon
        ? undefined
        : cached.get(eventTargetKey(planned.event.calendarId, planned.event.eventId));
      const event = known
        ? { ...planned.event, summary: known.fields.summary, fields: known.fields }
        : planned.event;
      due.push(eventDue(planned, event, user.timezone));
    } else if (planned.task) {
      const task = planned.task;
      due.push({
        key: planned.key,
        alsoKeys: [],
        dueAt: planned.at,
        kind: "task",
        task,
        rule: planned.rule,
        line: `[${task.listName}] ${task.title} · ${dueLabel(task.deadline, user.timezone)}`,
      });
    }
  }

  const logged = await loggedReminderKeys(
    deps.db,
    user.id,
    due.map((d) => d.key),
  );
  // Two of an item's reminders falling due together are one message.
  const merged = new Map<string, Due>();
  for (const d of due.filter((d) => !logged.has(d.key))) {
    const item = d.event ? `e:${d.event.calendarId}/${d.event.eventId}` : `t:${d.task?.id}`;
    const slot = `${item}:${d.dueAt}:${d.kind === "snooze" ? "snooze" : "item"}`;
    const same = merged.get(slot);
    if (same) same.alsoKeys.push(d.key);
    else merged.set(slot, d);
  }
  const all = [...merged.values()].sort((a, b) => a.dueAt - b.dueAt);
  // Each reminder is a claim statement; the rest go out on the next tick.
  if (all.length > MAX_DUE_PER_PASS) later(now);
  return { due: all.slice(0, MAX_DUE_PER_PASS), next };
}

function sameAnchor(a: ReminderAnchor, b: ReminderAnchor): boolean {
  if (a.kind === "instant") return b.kind === "instant" && a.at === b.at;
  return b.kind === "date" && a.date === b.date;
}

/**
 * Re-reads events before reminding: a cancelled or moved event is skipped (a
 * moved event gets its own reminder at the new time; for one beyond the
 * horizon, its kept start is updated). If Google cannot be reached, the
 * reminder is sent from what is known rather than missed.
 */
async function revalidate(
  deps: ReminderDeps,
  user: UserRecord,
  items: Due[],
): Promise<{ keep: Due[]; skip: Due[]; moved: D1PreparedStatement[] }> {
  const source = await deps.sourceFor(user.id);
  const keep: Due[] = [];
  const skip: Due[] = [];
  const moved: D1PreparedStatement[] = [];
  let checks = 0;
  for (const item of items) {
    if (!item.event || !source || checks >= MAX_REVALIDATIONS) {
      keep.push(item);
      continue;
    }
    checks++;
    const current = await source.getEvent(item.event.calendarId, item.event.eventId);
    if (!current.ok) {
      (current.error.kind === "not_found" ? skip : keep).push(item);
      continue;
    }
    const start = current.value.fields.start;
    const anchor: ReminderAnchor =
      "dateTime" in start
        ? { kind: "instant", at: Date.parse(start.dateTime) }
        : { kind: "date", date: start.date };
    const changed = !sameAnchor(anchor, item.event.anchor);
    if (current.value.status === "cancelled" || changed) {
      if (changed && current.value.status !== "cancelled" && !item.event.fromHorizon) {
        moved.push(
          reanchorStatement(
            deps.db,
            user.id,
            eventTargetKey(item.event.calendarId, item.event.eventId),
            anchor,
          ),
        );
      }
      skip.push(item);
      continue;
    }
    const display = current.value.display ?? item.event.display;
    const fields = current.value.fields;
    const refreshed = eventDue(
      {
        key: item.key,
        at: item.dueAt,
        rule: item.rule ?? { kind: "at", at: item.dueAt },
        setAt: null,
      },
      { ...item.event, summary: fields.summary, fields, display },
      user.timezone,
    );
    keep.push({ ...refreshed, alsoKeys: item.alsoKeys });
  }
  return { keep, skip, moved };
}

async function sendReminders(
  deps: ReminderDeps,
  user: UserRecord,
): Promise<{ sent: number; next: number | null }> {
  const now = deps.clock.now();
  const window = user.quietHours ? quietWindow(now, user.timezone, user.quietHours) : null;
  // Quiet hours: hold everything until the window ends (spec §7).
  if (window?.active) return { sent: 0, next: window.to };
  const { due: candidates, next } = await collectDue(deps, user, now);
  if (candidates.length === 0) return { sent: 0, next };
  const { keep, skip, moved } = await revalidate(deps, user, candidates);
  const claim = deps.ids.next();
  const statements = [
    ...moved,
    ...skip.flatMap((s) =>
      [s.key, ...s.alsoKeys].map((key) =>
        claimReminderStatement(deps.db, user.id, key, "skipped", claim, now, unguarded),
      ),
    ),
  ];
  if (keep.length === 0) {
    await deps.db.batch(statements);
    return { sent: 0, next };
  }

  const buttons = new ActionButtons(deps.ids, user.id, now);
  let text: string;
  let keyboard: InlineKeyboardButton[][] = [];
  // Held through quiet hours: always one summary.
  const held = window !== null && keep.some((k) => k.dueAt >= window.from && k.dueAt < window.to);
  const single =
    !held && keep.length === 1 && now - (keep[0]?.dueAt ?? now) < LATE_AFTER_MS ? keep[0] : null;
  if (single?.event) {
    ({ text, keyboard } = eventReminder(single.event));
  } else if (single?.task) {
    const title =
      single.kind === "snooze" || single.rule?.kind !== "before"
        ? "Reminder"
        : `Due ${minutesLabel(single.rule.minutes).toLowerCase()}`;
    text = `${title}: [${single.task.listName}] ${single.task.title}\n${dueLabel(single.task.deadline, user.timezone)}`;
    keyboard = [
      [
        buttons.button("Done", "task_done", {
          taskId: single.task.id,
          version: single.task.version,
        }),
        buttons.button("Snooze", "snooze_menu", { taskId: single.task.id }),
      ],
    ];
  } else {
    // Several at once, or late after downtime: one summary, never a burst.
    const late = keep.some((k) => now - k.dueAt >= LATE_AFTER_MS);
    text = [
      held
        ? "While quiet hours were on:"
        : late
          ? "Reminders I couldn't send on time:"
          : "Reminders:",
      ...keep.map((k) => `• ${k.line}`),
    ].join("\n");
    if (keep.some((k) => k.task))
      keyboard = [[buttons.button("View tasks", "task_list", { listId: null, page: 0 })]];
  }

  const outcome = single ? "sent" : "summarized";
  const keys = (items: Due[]) => items.flatMap((k) => [k.key, ...k.alsoKeys]);
  const claims = keys(keep).map((key) =>
    claimReminderStatement(deps.db, user.id, key, outcome, claim, now, unguarded),
  );
  const guard = allClaimedGuard(user.id, claim, keys(skip).length + keys(keep).length);
  await deps.db.batch([
    ...statements,
    ...claims,
    ...buttons.statements(deps.db, guard),
    enqueueStatement(
      deps.db,
      deps.ids,
      user.id,
      {
        logicalKey: `reminder:${keep.map((k) => k.key).join("|")}`.slice(0, 500),
        ...(single?.event
          ? {
              about: {
                kind: "event" as const,
                calendarId: single.event.calendarId,
                eventId: single.event.eventId,
              },
            }
          : single?.task
            ? { about: { kind: "task" as const, taskId: single.task.id } }
            : {}),
        call: {
          method: "sendMessage",
          params: {
            chat_id: user.privateChatId,
            text,
            ...(keyboard.length ? { reply_markup: { inline_keyboard: keyboard } } : {}),
          },
        },
      },
      now,
      guard,
    ),
  ]);
  logEvent("reminders.queued", { userId: user.id, count: keep.length, skipped: skip.length });
  return { sent: keep.length, next };
}
