import { renderDay, tasksForDay } from "../application/calendar-view";
import { ActionButtons } from "../application/reactions";
import { dueLabel } from "../application/task-flow";
import type { CalendarPort, CalendarSyncSource } from "../calendar/port";
import {
  agendaDueDate,
  DEFAULT_EVENT_REMINDER_MINUTES,
  DEFAULT_TASK_REMINDER_MINUTES,
  reminderKeys,
} from "../domain/schedule";
import type { Clock } from "../shared/clock";
import type { IdGenerator } from "../shared/ids";
import { logEvent } from "../shared/log";
import { unguarded } from "../storage/guard";
import { enqueueStatement } from "../storage/outbox";
import {
  agendaClaimGuard,
  agendaSent,
  allClaimedGuard,
  allReminderOverrides,
  claimAgendaStatement,
  claimReminderStatement,
  horizonEvents,
  loggedReminderKeys,
} from "../storage/reminders";
import { isSnoozed, reminderCandidateTasks, type TaskRecord } from "../storage/tasks";
import { findUserById, type UserRecord } from "../storage/users";
import type { InlineKeyboardButton } from "../telegram/api";
import { formatEventRange } from "../telegram/format";

/** A reminder this late counts as missed: it joins a single catch-up summary. */
export const LATE_AFTER_MS = 10 * 60_000;
/** Snooze reminders older than this are not sent at all. */
const SNOOZE_STALE_MS = 24 * 60 * 60_000;
/** Bounds Google reads for revalidation per user per tick. */
const MAX_REVALIDATIONS = 5;

export interface ReminderDeps {
  db: D1Database;
  clock: Clock;
  ids: IdGenerator;
  /** Live reads for agendas and event revalidation. */
  sourceFor: (userId: string) => Promise<ReminderSource | null>;
}

export type ReminderSource = CalendarSyncSource & Pick<CalendarPort, "getEvent">;

interface Due {
  key: string;
  dueAt: number;
  kind: "event" | "task" | "snooze";
  line: string;
  /** For events: what to revalidate. */
  event?: { calendarId: string; eventId: string; startsAt: number; text: string };
  task?: TaskRecord;
  minutes?: number;
}

/** Sends due agendas and reminders for up to `limit` users. */
export async function runReminders(deps: ReminderDeps, limit: number): Promise<number> {
  const { results } = await deps.db
    .prepare("SELECT id FROM users WHERE setup_step = 'done' AND status = 'active' LIMIT ?")
    .bind(limit)
    .all<{ id: string }>();
  let sent = 0;
  for (const { id } of results) {
    const user = await findUserById(deps.db, id);
    if (!user) continue;
    sent += (await sendAgenda(deps, user)) ? 1 : 0;
    sent += await sendReminders(deps, user);
  }
  return sent;
}

/**
 * One combined agenda per local date, sent at 8am or on the first tick after
 * (catch-up after downtime). Keyed by local date, so a timezone change cannot
 * produce a second agenda for a date already covered.
 */
async function sendAgenda(deps: ReminderDeps, user: UserRecord): Promise<boolean> {
  const now = deps.clock.now();
  const date = agendaDueDate(now, user.timezone);
  if (!date || (await agendaSent(deps.db, user.id, date))) return false;
  const { text } = await renderDay({ db: deps.db, sourceFor: deps.sourceFor }, user, date, now, {
    heading: "Here's your day.",
    includeSnoozed: false,
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
  const keyboard = [
    [
      buttons.button("View tasks", "task_list", { listId: null, page: 0 }),
      buttons.button("View week", "view_week", {}),
    ],
  ];
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

function minutesLabel(minutes: number): string {
  if (minutes === 0) return "Now";
  if (minutes % 1440 === 0) return minutes === 1440 ? "In 1 day" : `In ${minutes / 1440} days`;
  if (minutes % 60 === 0) return minutes === 60 ? "In 1 hour" : `In ${minutes / 60} hours`;
  return `In ${minutes} minutes`;
}

async function collectDue(deps: ReminderDeps, user: UserRecord, now: number): Promise<Due[]> {
  const due: Due[] = [];
  const overrides = await allReminderOverrides(deps.db, user.id);
  const eventOverrides = overrides.event;
  for (const e of await horizonEvents(deps.db, user.id, now, now + 7 * 86_400_000)) {
    if (e.declined) continue;
    const targetKey = `${e.calendarId}/${e.eventId}`;
    const minutes = eventOverrides.has(targetKey)
      ? eventOverrides.get(targetKey)
      : DEFAULT_EVENT_REMINDER_MINUTES;
    if (minutes === null || minutes === undefined) continue;
    const dueAt = e.startsAt - minutes * 60_000;
    if (dueAt > now) continue; // not yet; events already started are outside the window
    const range = formatEventRange(
      {
        start: { dateTime: new Date(e.startsAt).toISOString(), timeZone: user.timezone },
        end: { dateTime: new Date(e.endsAt).toISOString(), timeZone: user.timezone },
      },
      user.timezone,
    );
    due.push({
      key: reminderKeys.event(e.calendarId, e.eventId, e.startsAt, minutes),
      dueAt,
      kind: "event",
      minutes,
      line: `${e.summary} · ${range}`,
      event: {
        calendarId: e.calendarId,
        eventId: e.eventId,
        startsAt: e.startsAt,
        text: `${minutesLabel(minutes)}: ${e.summary}\n${range}`,
      },
    });
  }

  const taskOverrides = overrides.task;
  for (const task of await reminderCandidateTasks(deps.db, user.id, now, SNOOZE_STALE_MS)) {
    const label = `[${task.listName}] ${task.title}`;
    if (
      task.snoozedUntil !== null &&
      task.snoozedUntil <= now &&
      task.snoozedUntil > now - SNOOZE_STALE_MS
    ) {
      due.push({
        key: reminderKeys.snooze(task.id, task.snoozedUntil),
        dueAt: task.snoozedUntil,
        kind: "snooze",
        task,
        line: `${label} · ${dueLabel(task.deadline, user.timezone)}`,
      });
    }
    if (task.deadline.kind !== "datetime" || task.deadline.at <= now || isSnoozed(task, now))
      continue;
    const minutes = taskOverrides.has(task.id)
      ? taskOverrides.get(task.id)
      : DEFAULT_TASK_REMINDER_MINUTES;
    if (minutes === null || minutes === undefined) continue;
    const dueAt = task.deadline.at - minutes * 60_000;
    if (dueAt > now) continue;
    due.push({
      key: reminderKeys.taskDue(task.id, task.deadline.at, minutes),
      dueAt,
      kind: "task",
      task,
      minutes,
      line: `${label} · ${dueLabel(task.deadline, user.timezone)}`,
    });
  }

  const logged = await loggedReminderKeys(
    deps.db,
    user.id,
    due.map((d) => d.key),
  );
  return due.filter((d) => !logged.has(d.key)).sort((a, b) => a.dueAt - b.dueAt);
}

/**
 * Re-reads events before reminding: a cancelled or moved event is skipped (a
 * moved event gets its own reminder at the new time). If Google cannot be
 * reached, the reminder is sent from the horizon rather than missed.
 */
async function revalidate(
  deps: ReminderDeps,
  user: UserRecord,
  items: Due[],
): Promise<{ keep: Due[]; skip: Due[] }> {
  const source = await deps.sourceFor(user.id);
  const keep: Due[] = [];
  const skip: Due[] = [];
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
    const moved = !("dateTime" in start) || Date.parse(start.dateTime) !== item.event.startsAt;
    (current.value.status === "cancelled" || moved ? skip : keep).push(item);
  }
  return { keep, skip };
}

async function sendReminders(deps: ReminderDeps, user: UserRecord): Promise<number> {
  const now = deps.clock.now();
  const candidates = await collectDue(deps, user, now);
  if (candidates.length === 0) return 0;
  const { keep, skip } = await revalidate(deps, user, candidates);
  const claim = deps.ids.next();
  const statements = skip.map((s) =>
    claimReminderStatement(deps.db, user.id, s.key, "skipped", claim, now, unguarded),
  );
  if (keep.length === 0) {
    await deps.db.batch(statements);
    return 0;
  }

  const buttons = new ActionButtons(deps.ids, user.id, now);
  let text: string;
  let keyboard: InlineKeyboardButton[][] = [];
  const single =
    keep.length === 1 && now - (keep[0]?.dueAt ?? now) < LATE_AFTER_MS ? keep[0] : null;
  if (single?.event) {
    text = single.event.text;
  } else if (single?.task) {
    const heading =
      single.kind === "snooze"
        ? "Reminder"
        : `Due ${minutesLabel(single.minutes ?? 0).toLowerCase()}`;
    text = `${heading}: [${single.task.listName}] ${single.task.title}\n${dueLabel(single.task.deadline, user.timezone)}`;
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
      late ? "Reminders I couldn't send on time:" : "Reminders:",
      ...keep.map((k) => `• ${k.line}`),
    ].join("\n");
    if (keep.some((k) => k.task))
      keyboard = [[buttons.button("View tasks", "task_list", { listId: null, page: 0 })]];
  }

  const outcome = single ? "sent" : "summarized";
  const claims = keep.map((k) =>
    claimReminderStatement(deps.db, user.id, k.key, outcome, claim, now, unguarded),
  );
  const guard = allClaimedGuard(user.id, claim, skip.length + keep.length);
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
  return keep.length;
}
