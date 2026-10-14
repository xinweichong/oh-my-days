import { isWritable } from "../calendar/port";
import type { EventFields, EventTime } from "../domain/calendar-event";
import { parseDate, parseDuration, parseTime, parseTimeRange } from "../domain/parse-input";
import {
  describeRecurrence,
  firstOccurrence,
  parseRepeatInterval,
  type RepeatChoice,
  toRRule,
} from "../domain/recurrence";
import {
  addDays,
  type LocalDate,
  localDateAt,
  rfc3339,
  type WallTime,
  wallPartsAt,
  zonedInstant,
} from "../domain/time";
import { type CachedEvent, findCachedEvent } from "../storage/events";
import { findConnection, listStoredCalendars, type StoredCalendar } from "../storage/google";
import {
  clearPendingInputStatement,
  type PendingInput,
  type PendingInputKind,
  type UiAction,
} from "../storage/interactions";
import { findOperation } from "../storage/operations";
import { findTask } from "../storage/tasks";
import type { UserRecord } from "../storage/users";
import type { InlineKeyboardButton } from "../telegram/api";
import {
  formatDayLabel,
  formatEventRange,
  formatShortStart,
  formatWallTime,
} from "../telegram/format";
import type { InboundCallback, InboundMessage } from "../telegram/update";
import { eventsBetween, type SourceFor } from "./calendar-view";
import { cancelRow, guidedPrompt } from "./cancel";
import { dateChoiceLabel, whenQuestion } from "./choices";
import {
  CREATE_EVENT,
  type CreateEventIntent,
  DELETE_EVENT,
  type DeleteEventIntent,
  deletePreview,
  guestChangePreview,
  MOVE_EVENT,
  type MoveEventIntent,
  PATCH_EVENT,
  type PatchEventIntent,
  RESTORE_WINDOW_MS,
} from "./event-operations";
import { withTypingHint } from "./hints";
import { prepareProposal } from "./proposals";
import { ActionButtons, combine, message, type Reaction } from "./reactions";
import type { SetupDeps } from "./setup";
import { readRepeat, repeatRows } from "./task-flow";
import { answer, keyboardMessage, removeButtons } from "./ui";

/**
 * Structured event commands (no AI): guided creation, and choosing an upcoming
 * event to rename, move, or delete. Every change goes through the shared
 * operation pipeline, so results, retries, confirmations, and Undo behave the
 * same as for any other request.
 */

/** Spec §5: one hour when no end time or duration is given. */
export const DEFAULT_DURATION_MINUTES = 60;
const UPCOMING_DAYS = 14;
const PAGE_SIZE = 8;
const MAX_TITLE_LENGTH = 200;

export interface EventFlowDeps extends SetupDeps {
  sourceFor: SourceFor;
}

/** A creation in progress, or a move of an existing event. */
export interface Draft {
  title: string;
  date?: LocalDate;
  time?: WallTime;
  /** Present when moving an existing event rather than creating one. */
  move?: { calendarId: string; eventId: string; start: EventTime; end: EventTime };
  /** Moving every occurrence of a recurring series (time of day only). */
  series?: boolean;
  /** Scheduling work time for this task (a one-off event; the deadline is unchanged). */
  sessionFor?: { taskId: string };
}

/**
 * The event as Google has it now (occurrences of recurring events included),
 * falling back to the synced copy when Google cannot be reached.
 */
export async function loadEvent(
  deps: EventFlowDeps,
  user: UserRecord,
  calendarId: string,
  eventId: string,
): Promise<CachedEvent | null> {
  const source = await deps.sourceFor(user.id);
  if (source) {
    const live = await source.getEvent(calendarId, eventId);
    if (live.ok) {
      if (live.value.status === "cancelled") return null;
      return {
        calendarId,
        eventId,
        etag: live.value.etag,
        fields: live.value.fields,
        recurring: live.value.recurring ?? false,
        recurringEventId: live.value.recurringEventId ?? null,
        transparent: false,
        declined: false,
        hasGuests: live.value.hasGuests ?? false,
        organizerSelf: live.value.organizerSelf ?? true,
        attendees: live.value.attendees ?? [],
      };
    }
    if (live.error.kind === "not_found") return null;
  }
  return findCachedEvent(deps.db, user.id, calendarId, eventId);
}

function readDraft(payload: Record<string, unknown>): Draft | null {
  const draft = payload.draft as Draft | undefined;
  return draft && typeof draft.title === "string" ? draft : null;
}

// --- Entry ---------------------------------------------------------------------

export async function eventMenu(deps: EventFlowDeps, user: UserRecord): Promise<Reaction> {
  const blocked = await unavailable(deps, user);
  if (blocked) return blocked;
  const buttons = new ActionButtons(deps.ids, user.id, deps.clock.now());
  return {
    replies: [
      keyboardMessage(
        user,
        "Events",
        {
          inline_keyboard: [
            [
              buttons.button("New event", "event_new", {}),
              buttons.button("Change an event", "event_list", { page: 0 }),
            ],
          ],
        },
        null,
      ),
    ],
    statements: (db, guard) => buttons.statements(db, guard),
  };
}

export async function unavailable(deps: EventFlowDeps, user: UserRecord): Promise<Reaction | null> {
  if (user.setupStep !== "done") {
    return message(user.privateChatId, "Finish setup first: send /start to continue.");
  }
  const connection = await findConnection(deps.db, user.id);
  if (connection?.status !== "active") {
    return message(
      user.privateChatId,
      "Google Calendar needs to be reconnected first. Send /health to reconnect.",
    );
  }
  return null;
}

// --- Creation ------------------------------------------------------------------

function ask(
  deps: EventFlowDeps,
  user: UserRecord,
  kind: PendingInputKind,
  payload: Record<string, unknown>,
  text: string,
  keyboard: InlineKeyboardButton[][] = [],
  buttons?: ActionButtons,
): Reaction {
  return guidedPrompt(deps, user, kind, payload, text, keyboard, buttons);
}

function askTitle(deps: EventFlowDeps, user: UserRecord): Reaction {
  return ask(deps, user, "event_title", {}, "What's the event called?");
}

export function askDate(deps: EventFlowDeps, user: UserRecord, draft: Draft): Reaction {
  const today = localDateAt(deps.clock.now(), user.timezone);
  const buttons = new ActionButtons(deps.ids, user.id, deps.clock.now());
  const day = (offset: number) => {
    const date = addDays(today, offset);
    const prefix = offset === 0 ? "Today · " : offset === 1 ? "Tomorrow · " : "";
    return buttons.button(`${prefix}${formatDayLabel(date)}`, "event_date", { draft, date });
  };
  const keyboard = [
    [day(0), day(1)],
    [day(2), day(3)],
    [day(4), day(5)],
  ];
  const lead = draft.move
    ? `Move ${draft.title} to which day?`
    : draft.sessionFor
      ? `Which day do you want to work on ${draft.title}?`
      : `Which day is ${draft.title}?`;
  return ask(
    deps,
    user,
    "event_date",
    { draft },
    `${lead}\nOr type a date, like Fri, next Fri, in 3 days, or 9 Oct.`,
    keyboard,
    buttons,
  );
}

function askTime(deps: EventFlowDeps, user: UserRecord, draft: Draft): Reaction {
  const buttons = new ActionButtons(deps.ids, user.id, deps.clock.now());
  const keyboard =
    draft.move || draft.sessionFor ? [] : [[buttons.button("All day", "event_all_day", { draft })]];
  return ask(
    deps,
    user,
    "event_time",
    { draft },
    `What time on ${formatDayLabel(draft.date ?? "")}? Send a time like 7pm, or a range like 7-9pm.`,
    keyboard,
    buttons,
  );
}

function askDuration(deps: EventFlowDeps, user: UserRecord, draft: Draft): Reaction {
  const buttons = new ActionButtons(deps.ids, user.id, deps.clock.now());
  const option = (label: string, minutes: number) =>
    buttons.button(label, "event_duration", { draft, minutes });
  return ask(
    deps,
    user,
    "event_duration",
    { draft },
    "How long? Or type a duration (90m) or an end time (9pm).",
    [[option("30 min", 30), option("1 hour", 60), option("2 hours", 120)]],
    buttons,
  );
}

/** Builds the event's start and end in the user's timezone, refusing skipped times. */
export function timedFields(
  user: UserRecord,
  draft: Draft,
  length: { minutes: number } | { endTime: WallTime },
): { ok: true; start: EventTime; end: EventTime } | { ok: false; text: string } {
  const date = draft.date ?? "";
  const start = zonedInstant(date, draft.time ?? "", user.timezone);
  if (!start.ok) {
    return {
      ok: false,
      text: `${draft.time} doesn't exist on ${formatDayLabel(date)} in ${user.timezone} (clocks change). Send another time.`,
    };
  }
  let endInstant: number;
  if ("minutes" in length) {
    endInstant = start.instant + length.minutes * 60_000;
  } else {
    // An end time at or before the start means the next day.
    const sameDay = zonedInstant(date, length.endTime, user.timezone);
    const end =
      sameDay.ok && sameDay.instant > start.instant
        ? sameDay
        : zonedInstant(addDays(date, 1), length.endTime, user.timezone);
    if (!end.ok)
      return { ok: false, text: "That end time doesn't exist (clocks change). Send another." };
    endInstant = end.instant;
  }
  return {
    ok: true,
    start: { dateTime: rfc3339(start.instant, user.timezone), timeZone: user.timezone },
    end: { dateTime: rfc3339(endInstant, user.timezone), timeZone: user.timezone },
  };
}

/** The chosen calendar (default: the user's default), if listed and writable. */
async function writableTarget(deps: EventFlowDeps, user: UserRecord, calendarId: string | null) {
  const calendars = await listStoredCalendars(deps.db, user.id);
  const wanted = calendarId ?? user.defaultCalendarId;
  const target = calendars.find(
    (c) => c.calendarId === wanted && c.listed && isWritable(c.accessRole),
  );
  return { calendars, target };
}

/** Calendars a new event can go to: listed, writable, and not the task calendar. */
export function eventCalendars(user: UserRecord, calendars: StoredCalendar[]): StoredCalendar[] {
  return calendars.filter(
    (c) => c.listed && isWritable(c.accessRole) && c.calendarId !== user.taskCalendarId,
  );
}

function overlapCalendarIds(user: UserRecord, calendars: StoredCalendar[]): string[] {
  return calendars
    .filter((c) => c.selected && c.listed && c.calendarId !== user.taskCalendarId)
    .map((c) => c.calendarId);
}

function askEventRepeat(deps: EventFlowDeps, user: UserRecord, fields: EventFields): Reaction {
  const buttons = new ActionButtons(deps.ids, user.id, deps.clock.now());
  const option = (label: string, repeat: RepeatChoice | null) =>
    buttons.button(label, "event_repeat", { fields, repeat });
  return {
    replies: [
      keyboardMessage(
        user,
        `Does ${fields.summary} repeat?`,
        {
          inline_keyboard: [
            ...repeatRows(option),
            [buttons.button("Every…", "event_repeat_every", { fields })],
            cancelRow(buttons, `adding the event ${fields.summary}`),
          ],
        },
        null,
      ),
    ],
    statements: (db, guard) => [
      clearPendingInputStatement(db, user.id),
      ...buttons.statements(db, guard),
    ],
  };
}

/** The same event on another date: same local start time and length. */
function onDate(fields: EventFields, date: LocalDate): EventFields {
  const { start, end } = fields;
  if ("date" in start && "date" in end) {
    return {
      ...fields,
      start: { date },
      end: { date: addDays(date, daysBetween(start.date, end.date)) },
    };
  }
  if (!("dateTime" in start) || !("dateTime" in end)) return fields;
  const zone = start.timeZone ?? "UTC";
  const length = Date.parse(end.dateTime) - Date.parse(start.dateTime);
  const w = wallPartsAt(Date.parse(start.dateTime), zone);
  const moved = zonedInstant(
    date,
    `${String(w.hour).padStart(2, "0")}:${String(w.minute).padStart(2, "0")}`,
    zone,
  );
  if (!moved.ok) return fields;
  return {
    ...fields,
    start: { dateTime: rfc3339(moved.instant, zone), timeZone: zone },
    end: { dateTime: rfc3339(moved.instant + length, zone), timeZone: zone },
  };
}

function startDate(fields: EventFields): LocalDate {
  return "date" in fields.start ? fields.start.date : fields.start.dateTime.slice(0, 10);
}

export interface CreateOptions {
  /** A calendar other than the default (quick capture's `on <calendar>`). */
  calendarId?: string | null;
  /** Offered as "Make it a task" on the result (quick capture). */
  switchTo?: CreateEventIntent["switchTo"];
  /** A line appended to the result (e.g. a typing hint). */
  note?: string;
  /** Link the new event to this task as a work session. */
  sessionFor?: { taskId: string };
}

export async function create(
  deps: EventFlowDeps,
  user: UserRecord,
  fields: EventFields,
  idempotencyKey: string,
  repeat: RepeatChoice | null = null,
  options: CreateOptions = {},
): Promise<Reaction> {
  // A narrower rule may not include the chosen date: the series starts on its first date.
  const first = repeat ? firstOccurrence({ ...repeat, anchor: startDate(fields) }) : null;
  if (repeat && first && first !== startDate(fields)) fields = onDate(fields, first);
  const { calendars, target } = await writableTarget(deps, user, options.calendarId ?? null);
  if (!target) {
    return message(
      user.privateChatId,
      options.calendarId
        ? "That calendar isn't available for new events."
        : "Your default calendar isn't available for new events. Choose another in /settings.",
    );
  }
  const intent: CreateEventIntent = {
    calendarId: target.calendarId,
    eventId: deps.ids.next(),
    fields,
    calendarName: target.summary,
    overlapCalendarIds: overlapCalendarIds(user, calendars),
    ...(options.switchTo ? { switchTo: options.switchTo } : {}),
    ...(options.note ? { note: options.note } : {}),
    ...(options.sessionFor ? { sessionFor: options.sessionFor } : {}),
    // One-off events can be moved to another writable calendar from the result.
    ...(!repeat && eventCalendars(user, calendars).length > 1 ? { movable: true as const } : {}),
    ...(repeat
      ? {
          recurrence: [toRRule(repeat)],
          repeatLabel: describeRecurrence({ ...repeat, anchor: startDate(fields) }),
        }
      : {}),
  };
  const prepared = await prepareProposal(deps, user, {
    kind: CREATE_EVENT,
    idempotencyKey,
    intent,
    confirmation: null,
  });
  return combine(clearInput(user), { replies: prepared.replies, statements: prepared.statements });
}

function clearInput(user: UserRecord): Reaction {
  return { replies: [], statements: (db) => [clearPendingInputStatement(db, user.id)] };
}

// --- Choosing and changing an existing event ---------------------------------------

async function eventList(
  deps: EventFlowDeps,
  user: UserRecord,
  page: number,
  editMessageId: number | null,
): Promise<Reaction> {
  const now = deps.clock.now();
  const today = localDateAt(now, user.timezone);
  // Read live so occurrences of recurring events are listed too.
  const { events: all } = await eventsBetween(deps, user, today, addDays(today, UPCOMING_DAYS));
  const events = all.filter((e) => eventEndsAfter(e.fields, now, user.timezone));

  const buttons = new ActionButtons(deps.ids, user.id, now);
  const pickDate = [buttons.button("Pick a date", "event_pick_date", {})];
  if (events.length === 0) {
    return {
      replies: [
        keyboardMessage(
          user,
          `No upcoming events in the next ${UPCOMING_DAYS} days.`,
          { inline_keyboard: [pickDate] },
          null,
        ),
      ],
      statements: (db, guard) => buttons.statements(db, guard),
    };
  }
  const shown = events.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const rows = shown.map((e) => [
    buttons.button(
      truncate(`${formatShortStart(e.fields, user.timezone)} · ${e.fields.summary}`, 60),
      "event_pick",
      { calendarId: e.calendarId, eventId: e.eventId },
    ),
  ]);
  const nav: InlineKeyboardButton[] = [];
  if (page > 0) nav.push(buttons.button("Previous", "event_list", { page: page - 1 }));
  if ((page + 1) * PAGE_SIZE < events.length) {
    nav.push(buttons.button("More", "event_list", { page: page + 1 }));
  }
  if (nav.length) rows.push(nav);
  rows.push(pickDate);
  return {
    replies: [
      keyboardMessage(
        user,
        `Choose an event (next ${UPCOMING_DAYS} days), or pick a date.`,
        { inline_keyboard: rows },
        editMessageId,
      ),
    ],
    statements: (db, guard) => buttons.statements(db, guard),
  };
}

/** A just-created event, if its creation succeeded and it can still be moved from there. */
async function createdEvent(deps: EventFlowDeps, user: UserRecord, operationId: string) {
  const op = await findOperation(deps.db, user.id, operationId);
  if (op?.kind !== CREATE_EVENT || op.status !== "succeeded") return null;
  const intent = op.intent as CreateEventIntent;
  const result = op.result as { fields: EventFields } | null;
  return intent.movable && result ? { op, intent, fields: result.fields } : null;
}

/** "Calendar: Personal ▸": the other calendars a new event can go to. */
async function calendarMenu(
  deps: EventFlowDeps,
  user: UserRecord,
  operationId: string,
): Promise<Reaction> {
  const created = await createdEvent(deps, user, operationId);
  if (!created) return message(user.privateChatId, "This event can't be moved from here anymore.");
  const others = eventCalendars(user, await listStoredCalendars(deps.db, user.id)).filter(
    (c) => c.calendarId !== created.intent.calendarId,
  );
  if (others.length === 0) {
    return message(user.privateChatId, "There's no other calendar you can add events to.");
  }
  const buttons = new ActionButtons(deps.ids, user.id, deps.clock.now());
  const rows = others.map((c) => [
    buttons.button(c.summary, "event_calendar_move", { operationId, calendarId: c.calendarId }),
  ]);
  return {
    replies: [
      keyboardMessage(
        user,
        `Move ${created.fields.summary} to which calendar?`,
        { inline_keyboard: [...rows, cancelRow(buttons, "the move")] },
        null,
      ),
    ],
    statements: (db, guard) => buttons.statements(db, guard),
  };
}

/** Moves the just-created event, only if it is still exactly as created. */
async function moveToCalendar(
  deps: EventFlowDeps,
  user: UserRecord,
  operationId: string,
  calendarId: string,
  key: string,
): Promise<Reaction> {
  const created = await createdEvent(deps, user, operationId);
  if (!created) return message(user.privateChatId, "This event can't be moved from here anymore.");
  const destination = eventCalendars(user, await listStoredCalendars(deps.db, user.id)).find(
    (c) => c.calendarId === calendarId,
  );
  if (!destination || destination.calendarId === created.intent.calendarId) {
    return message(user.privateChatId, "That calendar isn't available for events.");
  }
  const intent: MoveEventIntent = {
    calendarId: created.intent.calendarId,
    eventId: created.intent.eventId,
    destinationId: destination.calendarId,
    title: created.fields.summary,
    calendarName: created.intent.calendarName ?? "its calendar",
    destinationName: destination.summary,
    base: created.fields,
  };
  const prepared = await prepareProposal(deps, user, {
    kind: MOVE_EVENT,
    idempotencyKey: key,
    intent,
    confirmation: null,
  });
  return { replies: prepared.replies, statements: prepared.statements };
}

/**
 * Restore after deleting an event without guests: a new event (new ID) with the
 * same title and time in the same calendar, within 24 hours. Only once.
 */
async function restoreDeleted(
  deps: EventFlowDeps,
  user: UserRecord,
  operationId: string,
): Promise<Reaction> {
  const op = await findOperation(deps.db, user.id, operationId);
  const result = op?.result as
    | { fields: EventFields; restorable?: boolean; deletedAt?: number }
    | null
    | undefined;
  if (
    op?.kind !== DELETE_EVENT ||
    op.status !== "succeeded" ||
    !result?.restorable ||
    (result.deletedAt ?? 0) + RESTORE_WINDOW_MS <= deps.clock.now()
  ) {
    return message(user.privateChatId, "This event can't be restored anymore.");
  }
  const intent = op.intent as DeleteEventIntent;
  return create(deps, user, result.fields, `restore:${op.id}`, null, {
    calendarId: intent.calendarId,
    note: "Restored as a copy: the title and time are back; a description, location, or attachments from the original are not.",
  });
}

/** Every event on one date (past or upcoming), to choose one to change. */
async function dayList(deps: EventFlowDeps, user: UserRecord, date: LocalDate): Promise<Reaction> {
  const { events: all } = await eventsBetween(deps, user, date, addDays(date, 1));
  const events = all.slice(0, 2 * PAGE_SIZE);
  if (events.length === 0) {
    return combine(
      clearInput(user),
      message(user.privateChatId, `No events on ${formatDayLabel(date)}.`),
    );
  }
  const buttons = new ActionButtons(deps.ids, user.id, deps.clock.now());
  const rows = events.map((e) => [
    buttons.button(
      truncate(`${formatShortStart(e.fields, user.timezone)} · ${e.fields.summary}`, 60),
      "event_pick",
      { calendarId: e.calendarId, eventId: e.eventId },
    ),
  ]);
  return combine(clearInput(user), {
    replies: [
      keyboardMessage(
        user,
        `Events on ${formatDayLabel(date)} ${date.slice(0, 4)}:`,
        { inline_keyboard: rows },
        null,
      ),
    ],
    statements: (db, guard) => buttons.statements(db, guard),
  });
}

function eventEndsAfter(fields: EventFields, now: number, timeZone: string): boolean {
  const { end } = fields;
  if ("dateTime" in end) return Date.parse(end.dateTime) > now;
  return end.date > localDateAt(now, timeZone);
}

/** Why an event can't be changed from Telegram yet, if it can't. */
export function restriction(
  event: CachedEvent,
  calendar: StoredCalendar | undefined,
): string | null {
  if (!calendar?.listed || !isWritable(calendar.accessRole)) {
    return "This calendar is view-only, so the event can't be changed here.";
  }
  if (event.hasGuests && !event.organizerSelf) {
    return "Someone else organizes this event, so changes here can't reach the other guests. Change your response in Google Calendar.";
  }
  if (event.hasGuests && !event.attendees) {
    return "Google Calendar couldn't be reached to read the guest list. Try again shortly.";
  }
  return null;
}

async function eventCard(
  deps: EventFlowDeps,
  user: UserRecord,
  calendarId: string,
  eventId: string,
): Promise<Reaction> {
  const event = await loadEvent(deps, user, calendarId, eventId);
  if (!event) return message(user.privateChatId, "I can't find that event anymore.");
  const calendar = (await listStoredCalendars(deps.db, user.id)).find(
    (c) => c.calendarId === calendarId,
  );
  const text = `${event.fields.summary}\n${formatEventRange(event.fields, user.timezone)} · ${calendar?.summary ?? "Unknown calendar"}`;
  const blocked = restriction(event, calendar);
  const buttons = new ActionButtons(deps.ids, user.id, deps.clock.now());
  const target = { calendarId, eventId };
  // Reminders can be set even for events that can't be changed here.
  const reminder = buttons.button("Reminder", "reminder_menu", {
    kind: "event",
    targetKey: `${calendarId}/${eventId}`,
    title: event.fields.summary,
  });
  const recurring = event.recurringEventId !== null;
  const occurrence = recurring ? " this" : "";
  const series = { calendarId, eventId: event.recurringEventId ?? eventId };
  const rows = blocked
    ? [[reminder]]
    : [
        [
          buttons.button(`Rename${occurrence}`, "event_rename", target),
          buttons.button(recurring ? "Move this" : "Change time", "event_move", target),
          buttons.button(`Delete${occurrence}`, "event_delete", target),
        ],
        ...(recurring
          ? [
              [
                buttons.button("Rename series", "event_series_rename", series),
                buttons.button("Series time", "event_series_time", series),
                buttons.button("Delete series", "event_series_delete", series),
              ],
            ]
          : []),
        [
          reminder,
          ...(event.organizerSelf ? [buttons.button("Invite", "event_invite", target)] : []),
        ],
      ];
  const note = recurring
    ? "\nPart of a recurring series: change this occurrence, or the whole series."
    : "";
  return {
    about: { kind: "event", calendarId, eventId },
    replies: [
      keyboardMessage(
        user,
        blocked ? `${text}\n\n${blocked}` : `${text}${note}`,
        { inline_keyboard: rows },
        null,
      ),
    ],
    statements: (db, guard) => buttons.statements(db, guard),
  };
}

export async function proposePatch(
  deps: EventFlowDeps,
  user: UserRecord,
  event: CachedEvent,
  patch: Partial<EventFields>,
  idempotencyKey: string,
  /** Present for whole-series changes, which are confirmed first (spec §4). */
  series?: { text: string },
): Promise<Reaction> {
  const calendars = await listStoredCalendars(deps.db, user.id);
  const calendar = calendars.find((c) => c.calendarId === event.calendarId);
  const base: Partial<EventFields> = {};
  for (const key of Object.keys(patch) as (keyof EventFields)[]) {
    Object.assign(base, { [key]: event.fields[key] });
  }
  const intent: PatchEventIntent = {
    calendarId: event.calendarId,
    eventId: event.eventId,
    title: event.fields.summary,
    base,
    patch,
    ...(calendar ? { calendarName: calendar.summary } : {}),
    ...(series
      ? { scope: "series" as const }
      : { overlapCalendarIds: overlapCalendarIds(user, calendars) }),
    // Guests are emailed about the change, so it is previewed with every recipient.
    ...(event.hasGuests ? { notify: { recipients: event.attendees ?? [] } } : {}),
  };
  const prepared = await prepareProposal(deps, user, {
    kind: PATCH_EVENT,
    idempotencyKey,
    intent,
    confirmation: intent.notify
      ? guestChangePreview(intent)
      : series
        ? {
            text: series.text,
            confirmLabel: "Change series",
            facts: { base, patch, scope: "series" },
          }
        : null,
  });
  return combine(clearInput(user), { replies: prepared.replies, statements: prepared.statements });
}

/** Applies a move: the same length at the new date (and time, for timed events). */
export async function move(
  deps: EventFlowDeps,
  user: UserRecord,
  draft: Draft,
  key: string,
): Promise<Reaction> {
  const target = draft.move;
  if (!target || !draft.date)
    return message(user.privateChatId, "That change expired. Send /event to start again.");
  const event = await loadEvent(deps, user, target.calendarId, target.eventId);
  if (!event) return message(user.privateChatId, "I can't find that event anymore.");

  let patch: Partial<EventFields>;
  if ("date" in target.start && "date" in target.end) {
    const span = daysBetween(target.start.date, target.end.date);
    patch = { start: { date: draft.date }, end: { date: addDays(draft.date, span) } };
  } else {
    const length =
      Date.parse((target.end as { dateTime: string }).dateTime) -
      Date.parse((target.start as { dateTime: string }).dateTime);
    // A series keeps its own timezone; a single event is placed in the user's.
    const zone = draft.series
      ? { ...user, timezone: (target.start as { timeZone: string }).timeZone }
      : user;
    const fields = timedFields(zone, draft, { minutes: Math.round(length / 60_000) });
    if (!fields.ok) return message(user.privateChatId, fields.text);
    patch = { start: fields.start, end: fields.end };
  }
  if (draft.series) {
    const range = formatEventRange({ ...event.fields, ...patch }, user.timezone);
    return proposePatch(deps, user, event, patch, key, {
      text: `Move every occurrence of ${event.fields.summary} to ${range.slice(range.indexOf(", ") + 2)}?\nEach occurrence keeps its date.`,
    });
  }
  return proposePatch(deps, user, event, patch, key);
}

function daysBetween(from: LocalDate, to: LocalDate): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

// --- Buttons -------------------------------------------------------------------

export function isEventAction(action: string): boolean {
  return action.startsWith("event_");
}

export async function handleEventAction(
  deps: EventFlowDeps,
  user: UserRecord,
  callback: InboundCallback,
  { action, payload }: UiAction,
): Promise<Reaction> {
  const blocked = await unavailable(deps, user);
  if (blocked) return combine(answer(callback), blocked);
  const key = `ui:${callback.data}`;
  const target = () => ({
    calendarId: String(payload.calendarId ?? ""),
    eventId: String(payload.eventId ?? ""),
  });

  switch (action) {
    case "event_new":
      return combine(answer(callback), askTitle(deps, user));
    case "event_list":
      return combine(
        answer(callback),
        await eventList(
          deps,
          user,
          Number(payload.page ?? 0),
          Number(payload.page ?? 0) > 0 ? callback.messageId : null,
        ),
      );
    case "event_calendar_menu":
      return combine(
        answer(callback),
        await calendarMenu(deps, user, String(payload.operationId ?? "")),
      );
    case "event_calendar_move":
      return combine(
        answer(callback),
        removeButtons(user, callback),
        await moveToCalendar(
          deps,
          user,
          String(payload.operationId ?? ""),
          String(payload.calendarId ?? ""),
          key,
        ),
      );
    case "event_restore":
      return combine(
        answer(callback),
        removeButtons(user, callback),
        await restoreDeleted(deps, user, String(payload.operationId ?? "")),
      );
    case "event_session_new":
      return combine(
        answer(callback),
        await scheduleSession(deps, user, String(payload.taskId ?? "")),
      );
    case "event_pick_date":
      return combine(
        answer(callback),
        ask(
          deps,
          user,
          "event_list_date",
          {},
          "Which day? Type a date, like Fri, 9 Oct, or 9/10/2025.",
        ),
      );
    case "event_day":
      if (typeof payload.date !== "string")
        return answer(callback, "This button is no longer valid.");
      return combine(
        answer(callback),
        removeButtons(user, callback),
        await dayList(deps, user, payload.date),
      );
    case "event_pick": {
      const { calendarId, eventId } = target();
      return combine(answer(callback), await eventCard(deps, user, calendarId, eventId));
    }
    case "event_rename": {
      const { calendarId, eventId } = target();
      const event = await loadEvent(deps, user, calendarId, eventId);
      if (!event) return answer(callback, "I can't find that event anymore.");
      return combine(
        answer(callback),
        removeButtons(user, callback),
        ask(deps, user, "event_rename", target(), `Send the new name for ${event.fields.summary}.`),
      );
    }
    case "event_move": {
      const { calendarId, eventId } = target();
      const event = await loadEvent(deps, user, calendarId, eventId);
      if (!event) return answer(callback, "I can't find that event anymore.");
      const draft: Draft = {
        title: event.fields.summary,
        move: { calendarId, eventId, start: event.fields.start, end: event.fields.end },
      };
      return combine(answer(callback), removeButtons(user, callback), askDate(deps, user, draft));
    }
    case "event_delete": {
      const { calendarId, eventId } = target();
      const event = await loadEvent(deps, user, calendarId, eventId);
      if (!event) return answer(callback, "I can't find that event anymore.");
      const intent: DeleteEventIntent = {
        calendarId,
        eventId,
        base: event.fields,
        ...(event.hasGuests ? { notify: { recipients: event.attendees ?? [] } } : {}),
      };
      const prepared = await prepareProposal(deps, user, {
        kind: DELETE_EVENT,
        idempotencyKey: key,
        intent,
        confirmation: deletePreview(intent, user),
      });
      return combine(answer(callback), removeButtons(user, callback), {
        replies: prepared.replies,
        statements: prepared.statements,
      });
    }
    case "event_series_rename": {
      const { calendarId, eventId } = target();
      const master = await loadEvent(deps, user, calendarId, eventId);
      if (!master) return answer(callback, "I can't find that series anymore.");
      return combine(
        answer(callback),
        removeButtons(user, callback),
        ask(
          deps,
          user,
          "event_rename",
          { ...target(), scope: "series" },
          `Send the new name for every occurrence of ${master.fields.summary}.`,
        ),
      );
    }
    case "event_series_time": {
      const { calendarId, eventId } = target();
      const master = await loadEvent(deps, user, calendarId, eventId);
      if (!master) return answer(callback, "I can't find that series anymore.");
      if (!("dateTime" in master.fields.start)) {
        return answer(callback, "All-day series can only be moved in Google Calendar for now.");
      }
      const draft: Draft = {
        title: master.fields.summary,
        date: master.fields.start.dateTime.slice(0, 10),
        series: true,
        move: { calendarId, eventId, start: master.fields.start, end: master.fields.end },
      };
      return combine(
        answer(callback),
        removeButtons(user, callback),
        ask(
          deps,
          user,
          "event_time",
          { draft },
          `New time for every occurrence of ${master.fields.summary}? Send a time like 10am.`,
        ),
      );
    }
    case "event_series_delete": {
      const { calendarId, eventId } = target();
      const master = await loadEvent(deps, user, calendarId, eventId);
      if (!master) return answer(callback, "I can't find that series anymore.");
      const intent: DeleteEventIntent = {
        calendarId,
        eventId,
        base: master.fields,
        scope: "series",
        ...(master.hasGuests ? { notify: { recipients: master.attendees ?? [] } } : {}),
      };
      const prepared = await prepareProposal(deps, user, {
        kind: DELETE_EVENT,
        idempotencyKey: key,
        intent,
        confirmation: deletePreview(intent, user),
      });
      return combine(answer(callback), removeButtons(user, callback), {
        replies: prepared.replies,
        statements: prepared.statements,
      });
    }
    case "event_repeat": {
      const fields = payload.fields as EventFields | undefined;
      if (!fields) return answer(callback, "This button is no longer valid.");
      const repeat = readRepeat(payload);
      return combine(
        answer(callback),
        removeButtons(user, callback),
        await withTypingHint(user, "event", (note) =>
          create(deps, user, fields, key, repeat, note ? { note } : {}),
        ),
      );
    }
    case "event_repeat_every": {
      const fields = payload.fields as EventFields | undefined;
      if (!fields) return answer(callback, "This button is no longer valid.");
      return combine(
        answer(callback),
        removeButtons(user, callback),
        ask(
          deps,
          user,
          "event_repeat_interval",
          { fields },
          "How often? Type every 2 days, every 3 weeks, or every 6 months.",
        ),
      );
    }
    case "event_date": {
      const draft = readDraft(payload);
      if (!draft || typeof payload.date !== "string")
        return answer(callback, "This button is no longer valid.");
      return combine(
        answer(callback),
        removeButtons(user, callback),
        await afterDate(deps, user, { ...draft, date: payload.date }, key),
      );
    }
    case "event_time": {
      const draft = readDraft(payload);
      if (!draft?.date || typeof payload.time !== "string")
        return answer(callback, "This button is no longer valid.");
      return combine(
        answer(callback),
        removeButtons(user, callback),
        await afterTime(deps, user, { ...draft, time: payload.time }, key),
      );
    }
    case "event_all_day": {
      const draft = readDraft(payload);
      if (!draft?.date) return answer(callback, "This button is no longer valid.");
      return combine(
        answer(callback),
        removeButtons(user, callback),
        askEventRepeat(deps, user, {
          summary: draft.title,
          start: { date: draft.date },
          end: { date: addDays(draft.date, 1) },
        }),
      );
    }
    case "event_duration": {
      const draft = readDraft(payload);
      const minutes = Number(payload.minutes);
      if (!draft?.date || !draft.time || !Number.isFinite(minutes)) {
        return answer(callback, "This button is no longer valid.");
      }
      return combine(
        answer(callback),
        removeButtons(user, callback),
        await finishTimed(deps, user, draft, { minutes }, key),
      );
    }
    default:
      return answer(callback, "This button is no longer valid.");
  }
}

async function afterDate(
  deps: EventFlowDeps,
  user: UserRecord,
  draft: Draft,
  key: string,
): Promise<Reaction> {
  // Moving an all-day event needs only the date.
  if (draft.move && "date" in draft.move.start) return move(deps, user, draft, key);
  return askTime(deps, user, draft);
}

async function afterTime(
  deps: EventFlowDeps,
  user: UserRecord,
  draft: Draft,
  key: string,
): Promise<Reaction> {
  return draft.move ? move(deps, user, draft, key) : askDuration(deps, user, draft);
}

async function finishTimed(
  deps: EventFlowDeps,
  user: UserRecord,
  draft: Draft,
  length: { minutes: number } | { endTime: WallTime },
  key: string,
): Promise<Reaction> {
  const fields = timedFields(user, draft, length);
  if (!fields.ok) return message(user.privateChatId, fields.text);
  const event = { summary: draft.title, start: fields.start, end: fields.end };
  if (draft.sessionFor) {
    // Work time: a one-off event linked to the task; the deadline stays as it is.
    return create(deps, user, event, key, null, {
      sessionFor: draft.sessionFor,
      note: `Work time for the task ${draft.title}. Its deadline is unchanged.`,
    });
  }
  return askEventRepeat(deps, user, event);
}

/** "Schedule time" on a task: guided day, time, and length for a work session. */
async function scheduleSession(
  deps: EventFlowDeps,
  user: UserRecord,
  taskId: string,
): Promise<Reaction> {
  const task = await findTask(deps.db, user.id, taskId);
  if (task?.status !== "open") {
    return message(user.privateChatId, "That task is no longer open.");
  }
  return askDate(deps, user, { title: task.title, sessionFor: { taskId } });
}

// --- Typed answers -------------------------------------------------------------

export function isEventInput(kind: PendingInputKind): boolean {
  return kind.startsWith("event_");
}

export async function handleEventInput(
  deps: EventFlowDeps,
  user: UserRecord,
  input: InboundMessage,
  pending: PendingInput,
): Promise<Reaction> {
  const text = (input.text ?? "").trim();
  const key = `msg:${input.messageId}`;
  const draft = readDraft(pending.payload);
  const today = localDateAt(deps.clock.now(), user.timezone);

  switch (pending.kind) {
    case "event_title": {
      if (text.length === 0 || text.length > MAX_TITLE_LENGTH) {
        return message(user.privateChatId, `Send a name of up to ${MAX_TITLE_LENGTH} characters.`);
      }
      return askDate(deps, user, { title: text });
    }
    case "event_date": {
      const date = parseDate(text, today);
      if (!draft) break;
      if (!date) {
        return message(
          user.privateChatId,
          "I didn't recognize that date. Try Fri, next Fri, in 3 days, 9 Oct, or 9/10.",
        );
      }
      if ("choose" in date) {
        const buttons = new ActionButtons(deps.ids, user.id, deps.clock.now());
        const row = date.choose.map((d) =>
          buttons.button(dateChoiceLabel(d, today), "event_date", { draft, date: d }),
        );
        const question = whenQuestion(date.choose.map((d) => ({ date: d, time: null })));
        return ask(deps, user, "event_date", { draft }, question, [row], buttons);
      }
      return afterDate(deps, user, { ...draft, date: date.date }, key);
    }
    case "event_time": {
      if (!draft) break;
      const range = draft.move ? null : parseTimeRange(text);
      if (range)
        return finishTimed(
          deps,
          user,
          { ...draft, time: range.start },
          { endTime: range.end },
          key,
        );
      const time = parseTime(text);
      if (!time) {
        return message(
          user.privateChatId,
          "I didn't recognize that time. Try 7pm, 19:00, or a range like 7-9pm.",
        );
      }
      if ("choose" in time) {
        const buttons = new ActionButtons(deps.ids, user.id, deps.clock.now());
        const row = time.choose.map((t) =>
          buttons.button(formatWallTime(t), "event_time", { draft, time: t }),
        );
        const question = whenQuestion(time.choose.map((t) => ({ date: null, time: t })));
        return ask(deps, user, "event_time", { draft }, question, [row], buttons);
      }
      return afterTime(deps, user, { ...draft, time: time.time }, key);
    }
    case "event_duration": {
      const length = parseDuration(text);
      if (!draft) break;
      if (!length) {
        return message(
          user.privateChatId,
          "I didn't recognize that. Try 90m, 2 hours, or an end time like 9pm.",
        );
      }
      return finishTimed(deps, user, draft, length, key);
    }
    case "event_repeat_interval": {
      const fields = pending.payload.fields as EventFields | undefined;
      if (!fields) break;
      const repeat = parseRepeatInterval(text);
      if (!repeat) {
        return message(
          user.privateChatId,
          "I didn't recognize that. Try every 2 days, every 3 weeks, or every 6 months.",
        );
      }
      return combine(
        clearInput(user),
        await withTypingHint(user, "event", (note) =>
          create(deps, user, fields, key, repeat, note ? { note } : {}),
        ),
      );
    }
    case "event_list_date": {
      const date = parseDate(text, today);
      if (!date) {
        return message(
          user.privateChatId,
          "I didn't recognize that date. Try Fri, 9 Oct, or 9/10/2025.",
        );
      }
      if ("choose" in date) {
        const buttons = new ActionButtons(deps.ids, user.id, deps.clock.now());
        const row = date.choose.map((d) =>
          buttons.button(dateChoiceLabel(d, today), "event_day", { date: d }),
        );
        const question = whenQuestion(date.choose.map((d) => ({ date: d, time: null })));
        return ask(deps, user, "event_list_date", {}, question, [row], buttons);
      }
      return dayList(deps, user, date.date);
    }
    case "event_rename": {
      if (text.length === 0 || text.length > MAX_TITLE_LENGTH) {
        return message(user.privateChatId, `Send a name of up to ${MAX_TITLE_LENGTH} characters.`);
      }
      const event = await loadEvent(
        deps,
        user,
        String(pending.payload.calendarId ?? ""),
        String(pending.payload.eventId ?? ""),
      );
      if (!event)
        return combine(
          clearInput(user),
          message(user.privateChatId, "I can't find that event anymore."),
        );
      return pending.payload.scope === "series"
        ? proposePatch(deps, user, event, { summary: text }, key, {
            text: `Rename every occurrence of ${event.fields.summary} to ${text}?`,
          })
        : proposePatch(deps, user, event, { summary: text }, key);
    }
    default:
      break;
  }
  return combine(
    clearInput(user),
    message(user.privateChatId, "That request expired. Send /event to start again."),
  );
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Proposes deleting an event, confirmed first (with guest recipients when it has guests). */
export async function proposeEventDelete(
  deps: EventFlowDeps,
  user: UserRecord,
  event: CachedEvent,
  idempotencyKey: string,
): Promise<Reaction> {
  const intent: DeleteEventIntent = {
    calendarId: event.calendarId,
    eventId: event.eventId,
    base: event.fields,
    ...(event.hasGuests ? { notify: { recipients: event.attendees ?? [] } } : {}),
  };
  const prepared = await prepareProposal(deps, user, {
    kind: DELETE_EVENT,
    idempotencyKey,
    intent,
    confirmation: deletePreview(intent, user),
  });
  return { replies: prepared.replies, statements: prepared.statements };
}
