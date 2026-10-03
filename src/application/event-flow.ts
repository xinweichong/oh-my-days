import { isWritable } from "../calendar/port";
import type { EventFields, EventTime } from "../domain/calendar-event";
import { parseDuration, parseLocalDate, parseWallTime } from "../domain/parse-input";
import { describeRecurrence, type Frequency, toRRule } from "../domain/recurrence";
import {
  addDays,
  type LocalDate,
  localDateAt,
  rfc3339,
  type WallTime,
  zonedInstant,
} from "../domain/time";
import { type CachedEvent, findCachedEvent } from "../storage/events";
import { findConnection, listStoredCalendars, type StoredCalendar } from "../storage/google";
import {
  clearPendingInputStatement,
  type PendingInput,
  type PendingInputKind,
  setPendingInputStatement,
  type UiAction,
} from "../storage/interactions";
import type { UserRecord } from "../storage/users";
import type { InlineKeyboardButton } from "../telegram/api";
import { formatDayLabel, formatEventRange, formatShortStart } from "../telegram/format";
import type { InboundCallback, InboundMessage } from "../telegram/update";
import { eventsBetween, type SourceFor } from "./calendar-view";
import {
  CREATE_EVENT,
  type CreateEventIntent,
  DELETE_EVENT,
  type DeleteEventIntent,
  deletePreview,
  PATCH_EVENT,
  type PatchEventIntent,
} from "./event-operations";
import { prepareProposal } from "./proposals";
import { ActionButtons, combine, message, type Reaction } from "./reactions";
import { PENDING_INPUT_TTL_MS, type SetupDeps } from "./setup";
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
interface Draft {
  title: string;
  date?: LocalDate;
  time?: WallTime;
  /** Present when moving an existing event rather than creating one. */
  move?: { calendarId: string; eventId: string; start: EventTime; end: EventTime };
  /** Moving every occurrence of a recurring series (time of day only). */
  series?: boolean;
}

/**
 * The event as Google has it now (occurrences of recurring events included),
 * falling back to the synced copy when Google cannot be reached.
 */
async function loadEvent(
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
        organizerSelf: true,
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

async function unavailable(deps: EventFlowDeps, user: UserRecord): Promise<Reaction | null> {
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
  const now = deps.clock.now();
  return {
    replies: [
      keyboard.length
        ? keyboardMessage(user, text, { inline_keyboard: keyboard }, null)
        : { method: "sendMessage", params: { chat_id: user.privateChatId, text } },
    ],
    statements: (db, guard) => [
      setPendingInputStatement(db, user.id, kind, now + PENDING_INPUT_TTL_MS, now, payload),
      ...(buttons?.statements(db, guard) ?? []),
    ],
  };
}

function askTitle(deps: EventFlowDeps, user: UserRecord): Reaction {
  return ask(deps, user, "event_title", {}, "What's the event called?");
}

function askDate(deps: EventFlowDeps, user: UserRecord, draft: Draft): Reaction {
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
  const lead = draft.move ? `Move ${draft.title} to which day?` : `Which day is ${draft.title}?`;
  return ask(
    deps,
    user,
    "event_date",
    { draft },
    `${lead}\nOr type a date, like 9 Oct or 9/10.`,
    keyboard,
    buttons,
  );
}

function askTime(deps: EventFlowDeps, user: UserRecord, draft: Draft): Reaction {
  const buttons = new ActionButtons(deps.ids, user.id, deps.clock.now());
  const keyboard = draft.move ? [] : [[buttons.button("All day", "event_all_day", { draft })]];
  return ask(
    deps,
    user,
    "event_time",
    { draft },
    `What time on ${formatDayLabel(draft.date ?? "")}? Send a time like 19:00 or 7pm.`,
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
function timedFields(
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

async function writableDefault(deps: EventFlowDeps, user: UserRecord) {
  const calendars = await listStoredCalendars(deps.db, user.id);
  const target = calendars.find(
    (c) => c.calendarId === user.defaultCalendarId && c.listed && isWritable(c.accessRole),
  );
  return { calendars, target };
}

function overlapCalendarIds(user: UserRecord, calendars: StoredCalendar[]): string[] {
  return calendars
    .filter((c) => c.selected && c.listed && c.calendarId !== user.taskCalendarId)
    .map((c) => c.calendarId);
}

function askEventRepeat(deps: EventFlowDeps, user: UserRecord, fields: EventFields): Reaction {
  const buttons = new ActionButtons(deps.ids, user.id, deps.clock.now());
  const option = (label: string, freq: Frequency | null) =>
    buttons.button(label, "event_repeat", { fields, freq });
  return {
    replies: [
      keyboardMessage(
        user,
        `Does ${fields.summary} repeat?`,
        {
          inline_keyboard: [
            [option("Doesn't repeat", null)],
            [option("Daily", "daily"), option("Weekly", "weekly")],
            [option("Monthly", "monthly"), option("Yearly", "yearly")],
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

function startDate(fields: EventFields): LocalDate {
  return "date" in fields.start ? fields.start.date : fields.start.dateTime.slice(0, 10);
}

async function create(
  deps: EventFlowDeps,
  user: UserRecord,
  fields: EventFields,
  idempotencyKey: string,
  freq: Frequency | null = null,
): Promise<Reaction> {
  const { calendars, target } = await writableDefault(deps, user);
  if (!target) {
    return message(
      user.privateChatId,
      "Your default calendar isn't available for new events. Choose another in /settings.",
    );
  }
  const intent: CreateEventIntent = {
    calendarId: target.calendarId,
    eventId: deps.ids.next(),
    fields,
    calendarName: target.summary,
    overlapCalendarIds: overlapCalendarIds(user, calendars),
    ...(freq
      ? {
          recurrence: [toRRule(freq)],
          repeatLabel: describeRecurrence({ freq, interval: 1, anchor: startDate(fields) }),
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

  if (events.length === 0) {
    return message(user.privateChatId, `No upcoming events in the next ${UPCOMING_DAYS} days.`);
  }
  const shown = events.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const buttons = new ActionButtons(deps.ids, user.id, now);
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
  return {
    replies: [
      keyboardMessage(
        user,
        `Choose an event (next ${UPCOMING_DAYS} days).`,
        { inline_keyboard: rows },
        editMessageId,
      ),
    ],
    statements: (db, guard) => buttons.statements(db, guard),
  };
}

function eventEndsAfter(fields: EventFields, now: number, timeZone: string): boolean {
  const { end } = fields;
  if ("dateTime" in end) return Date.parse(end.dateTime) > now;
  return end.date > localDateAt(now, timeZone);
}

/** Why an event can't be changed from Telegram yet, if it can't. */
function restriction(event: CachedEvent, calendar: StoredCalendar | undefined): string | null {
  if (!calendar?.listed || !isWritable(calendar.accessRole)) {
    return "This calendar is view-only, so the event can't be changed here.";
  }
  if (event.hasGuests) {
    return "This event has guests. Changing it from Telegram isn't available yet, because it could notify them.";
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
        [reminder],
      ];
  const note = recurring
    ? "\nPart of a recurring series: change this occurrence, or the whole series."
    : "";
  return {
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

async function proposePatch(
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
  };
  const prepared = await prepareProposal(deps, user, {
    kind: PATCH_EVENT,
    idempotencyKey,
    intent,
    confirmation: series
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
async function move(
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
      const intent: DeleteEventIntent = { calendarId, eventId, base: event.fields };
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
      const freq = typeof payload.freq === "string" ? (payload.freq as Frequency) : null;
      return combine(
        answer(callback),
        removeButtons(user, callback),
        await create(deps, user, fields, key, freq),
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
        await finishTimed(deps, user, draft, { minutes }),
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

async function finishTimed(
  deps: EventFlowDeps,
  user: UserRecord,
  draft: Draft,
  length: { minutes: number } | { endTime: WallTime },
): Promise<Reaction> {
  const fields = timedFields(user, draft, length);
  if (!fields.ok) return message(user.privateChatId, fields.text);
  return askEventRepeat(deps, user, { summary: draft.title, start: fields.start, end: fields.end });
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
      const date = parseLocalDate(text, today);
      if (!draft) break;
      if (!date) {
        return message(
          user.privateChatId,
          "I didn't recognize that date. Try 9 Oct, 9/10, or 2026-10-09.",
        );
      }
      return afterDate(deps, user, { ...draft, date }, key);
    }
    case "event_time": {
      const time = parseWallTime(text);
      if (!draft) break;
      if (!time)
        return message(user.privateChatId, "I didn't recognize that time. Try 19:00 or 7pm.");
      const next = { ...draft, time };
      return next.move ? move(deps, user, next, key) : askDuration(deps, user, next);
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
      return finishTimed(deps, user, draft, length);
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
