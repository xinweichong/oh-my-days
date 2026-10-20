import type { EventFields } from "../domain/calendar-event";
import {
  checkRule,
  decodeRule,
  defaultRules,
  encodeRule,
  MAX_RULES,
  mergeRules,
  parseReminders,
  type ReminderAnchor,
  type ReminderRule,
  type ResolveProblem,
  resolveEntries,
  ruleTime,
} from "../domain/reminders";
import { localDateAt } from "../domain/time";
import { findCachedEvent } from "../storage/events";
import { listStoredCalendars } from "../storage/google";
import {
  clearPendingInputOfKindStatement,
  type PendingInput,
  type UiAction,
} from "../storage/interactions";
import {
  clearRemindersStatement,
  findReminderSetting,
  type ReminderSetting,
  setRemindersStatement,
  type TargetKind,
} from "../storage/reminders";
import { findTask, type TaskRecord } from "../storage/tasks";
import type { UserRecord } from "../storage/users";
import type { InlineKeyboardButton } from "../telegram/api";
import { formatDayLabel, formatTime, formatWallTime } from "../telegram/format";
import type { InboundCallback, InboundMessage } from "../telegram/update";
import type { SourceFor } from "./calendar-view";
import { guidedPrompt } from "./cancel";
import { ActionButtons, combine, message, type Reaction } from "./reactions";
import { eventTargetKey, splitEventKey } from "./reminder-plan";
import type { SetupDeps } from "./setup";
import { answer, keyboardMessage } from "./ui";

/**
 * An item's own reminders (ADR 0008): several per event or task, from presets,
 * typed text ("1 day before 6pm, 2h"), or a reply such as "remind me Thu 9am".
 * Reminders change nothing in Google, so they can be set on any event shown,
 * including view-only ones.
 */

/** The item reminders are set on. Tasks are re-read; events carry their start. */
export interface ReminderTarget {
  kind: TargetKind;
  /** "<calendarId>/<eventId>" or a task ID. */
  targetKey: string;
  title: string;
  /** Events only: the start (or all-day date) as shown. */
  anchor?: ReminderAnchor;
}

export function eventTarget(
  calendarId: string,
  eventId: string,
  fields: Pick<EventFields, "summary" | "start">,
): ReminderTarget {
  const start = fields.start;
  return {
    kind: "event",
    targetKey: eventTargetKey(calendarId, eventId),
    title: fields.summary,
    anchor:
      "dateTime" in start
        ? { kind: "instant", at: Date.parse(start.dateTime) }
        : { kind: "date", date: start.date },
  };
}

export function taskTarget(task: Pick<TaskRecord, "id" | "title">): ReminderTarget {
  return { kind: "task", targetKey: task.id, title: task.title };
}

export function taskAnchor(task: Pick<TaskRecord, "deadline">): ReminderAnchor | null {
  if (task.deadline.kind === "datetime") return { kind: "instant", at: task.deadline.at };
  if (task.deadline.kind === "date") return { kind: "date", date: task.deadline.date };
  return null;
}

/** Marks a message as about the item, so a reply to it ("remind me 2h") finds it. */
function about(target: ReminderTarget): Pick<Reaction, "about"> {
  if (target.kind === "task") return { about: { kind: "task", taskId: target.targetKey } };
  const [calendarId, eventId] = splitEventKey(target.targetKey);
  return { about: { kind: "event", calendarId, eventId } };
}

// --- Labels ---------------------------------------------------------------------------

function leadText(minutes: number): string {
  if (minutes === 0) return "At the time";
  if (minutes % 1440 === 0) return minutes === 1440 ? "1 day" : `${minutes / 1440} days`;
  if (minutes % 60 === 0) return minutes === 60 ? "1 hour" : `${minutes / 60} hours`;
  return `${minutes} minutes`;
}

/** "1 hour before", "1 day before at 6pm", "On the day at 9am", "Thu 1 Oct at 9am". */
export function ruleLabel(rule: ReminderRule, timeZone: string): string {
  switch (rule.kind) {
    case "before":
      return rule.minutes === 0 ? "At the time" : `${leadText(rule.minutes)} before`;
    case "day": {
      const time = formatWallTime(rule.time);
      if (rule.days === 0) return `On the day at ${time}`;
      return `${rule.days === 1 ? "1 day" : `${rule.days} days`} before at ${time}`;
    }
    case "at":
      return `${formatDayLabel(localDateAt(rule.at, timeZone))} at ${formatTime(rule.at, timeZone)}`;
  }
}

/** Rules in firing order for the item, labelled. */
export function ruleLabels(
  rules: readonly ReminderRule[],
  anchor: ReminderAnchor | null,
  timeZone: string,
): string[] {
  const order = (r: ReminderRule) => (anchor ? (ruleTime(r, anchor, timeZone) ?? 0) : 0);
  return [...rules].sort((a, b) => order(a) - order(b)).map((r) => ruleLabel(r, timeZone));
}

export function problemText(problem: ResolveProblem, kind: TargetKind, agendaHour: number): string {
  switch (problem) {
    case "passed":
      return "that time has passed";
    case "after":
      return kind === "event" ? "that's after it starts" : "that's after the deadline";
    case "needs_time":
      return `a deadline without a time needs a day and time, like 1 day before 6pm (a whole day alone means ${agendaLabel({ agendaHour })})`;
    case "too_early":
      return "reminders can be up to 7 days before";
    case "time_skipped":
      return "that time doesn't exist on that day (clocks change)";
  }
}

const TIMED_PRESETS: readonly [string, ReminderRule][] = [
  ["10 min", { kind: "before", minutes: 10 }],
  ["30 min", { kind: "before", minutes: 30 }],
  ["1 hour", { kind: "before", minutes: 60 }],
  ["2 hours", { kind: "before", minutes: 120 }],
  ["1 day", { kind: "before", minutes: 1440 }],
];

const DATE_PRESETS: readonly [string, ReminderRule][] = [
  ["Day before 9am", { kind: "day", days: 1, time: "09:00" }],
  ["Day before 6pm", { kind: "day", days: 1, time: "18:00" }],
  ["On the day 12pm", { kind: "day", days: 0, time: "12:00" }],
  ["2 days before 9am", { kind: "day", days: 2, time: "09:00" }],
];

/** Preset choices for an item, as labels and rule codes (shared with the Mini App). */
export function reminderPresets(anchor: ReminderAnchor): { label: string; code: string }[] {
  return (anchor.kind === "instant" ? TIMED_PRESETS : DATE_PRESETS).map(([label, rule]) => ({
    label,
    code: encodeRule(rule),
  }));
}

/** Why a rule can't be added to an item now, as a sentence, or null. */
export function checkRuleText(
  rule: ReminderRule,
  anchor: ReminderAnchor,
  user: UserRecord,
  kind: TargetKind,
  now: number,
): string | null {
  const problem = checkRule(rule, anchor, { now, timeZone: user.timezone });
  return problem
    ? `${ruleLabel(rule, user.timezone)}: ${problemText(problem, kind, user.agendaHour)}.`
    : null;
}

// --- Current state ----------------------------------------------------------------------

export interface ReminderState {
  anchor: ReminderAnchor;
  setting: ReminderSetting | null;
  /** What applies now: the item's own reminders, or the default. */
  rules: ReminderRule[];
}

/** The item's time and reminders, or why reminders can't be set on it. */
export async function reminderState(
  deps: Pick<SetupDeps, "db">,
  user: UserRecord,
  target: ReminderTarget,
): Promise<ReminderState | { error: string }> {
  let anchor = target.anchor ?? null;
  if (target.kind === "task") {
    const task = await findTask(deps.db, user.id, target.targetKey);
    if (task?.status !== "open") return { error: "That task isn't open anymore." };
    anchor = taskAnchor(task);
    if (!anchor) {
      return {
        error: `${task.title} has no deadline, so there's nothing to remind before. Snooze it to be reminded at a time.`,
      };
    }
  }
  if (!anchor) return { error: "I can't tell when that is. Open it again from /event." };
  const setting = await findReminderSetting(deps.db, user.id, target.kind, target.targetKey);
  return {
    anchor,
    setting,
    rules: setting ? setting.rules : defaultRules(anchor, user.reminderMinutes),
  };
}

/** "Sat 26 Sep, 7pm", or the date of a date-only item. */
export function anchorLabel(anchor: ReminderAnchor, timeZone: string): string {
  if (anchor.kind === "date") return formatDayLabel(anchor.date);
  return `${formatDayLabel(localDateAt(anchor.at, timeZone))}, ${formatTime(anchor.at, timeZone)}`;
}

/** "Reminders for Dinner: 1 day before at 6pm; 1 hour before." */
export function reminderSummary(
  user: UserRecord,
  title: string,
  state: Pick<ReminderState, "anchor" | "rules" | "setting">,
): string {
  const labels = ruleLabels(state.rules, state.anchor, user.timezone);
  if (labels.length) return `Reminders for ${title}: ${labels.join("; ")}.`;
  return state.anchor.kind === "date" && !state.setting
    ? `No reminders for ${title}; it's in the ${agendaLabel(user)} agenda on the day.`
    : `No reminders for ${title}.`;
}

function agendaLabel(user: Pick<UserRecord, "agendaHour">): string {
  return formatWallTime(`${String(user.agendaHour).padStart(2, "0")}:00`);
}

// --- Menu ------------------------------------------------------------------------------

/** The reminder menu: presets to tap on and off, Custom…, Default, None. */
export async function reminderMenu(
  deps: SetupDeps,
  user: UserRecord,
  target: ReminderTarget,
  editMessageId: number | null = null,
  known?: ReminderState,
): Promise<Reaction> {
  const state = known ?? (await reminderState(deps, user, target));
  if ("error" in state) return message(user.privateChatId, state.error);
  const tz = user.timezone;
  const buttons = new ActionButtons(deps.ids, user.id, deps.clock.now());
  const on = new Set(state.rules.map(encodeRule));
  const presets = reminderPresets(state.anchor);
  const presetCodes = new Set(presets.map((p) => p.code));
  const toggle = (label: string, code: string) =>
    buttons.button(`${on.has(code) ? "✓ " : ""}${label}`, "reminder_toggle", { target, code });
  const rows: InlineKeyboardButton[][] = [];
  const presetButtons = presets.map((p) => toggle(p.label, p.code));
  for (let i = 0; i < presetButtons.length; i += 3) rows.push(presetButtons.slice(i, i + 3));
  // The item's own reminders that aren't presets, each removable.
  for (const rule of state.rules) {
    const code = encodeRule(rule);
    if (!presetCodes.has(code)) rows.push([toggle(ruleLabel(rule, tz), code)]);
  }
  const last = [buttons.button("Custom…", "reminder_custom", { target })];
  if (state.setting) last.push(buttons.button("Default", "reminder_default", { target }));
  if (state.rules.length) last.push(buttons.button("None", "reminder_none", { target }));
  rows.push(last);

  const labels = ruleLabels(state.rules, state.anchor, tz);
  const current = labels.length
    ? labels.map((l) => `• ${l}`)
    : [
        state.anchor.kind === "date" && !state.setting
          ? `None; it's in the ${agendaLabel(user)} agenda on the day.`
          : "None.",
      ];
  const text = [
    `Reminders for ${target.title}`,
    anchorLabel(state.anchor, tz),
    "",
    ...current,
    "",
    `Tap to add or remove (up to ${MAX_RULES}). Custom… takes your own, like 45m, 1 day before 6pm, or Thu 9am.`,
  ].join("\n");
  return {
    ...about(target),
    replies: [keyboardMessage(user, text, { inline_keyboard: rows }, editMessageId)],
    statements: (db, guard) => buttons.statements(db, guard),
  };
}

function write(
  user: UserRecord,
  target: ReminderTarget,
  rules: readonly ReminderRule[] | "default",
  anchor: ReminderAnchor,
  now: number,
): Reaction {
  return {
    replies: [],
    statements: (db) => [
      clearPendingInputOfKindStatement(db, user.id, "reminder_input"),
      rules === "default"
        ? clearRemindersStatement(db, user.id, target.kind, target.targetKey)
        : setRemindersStatement(
            db,
            user.id,
            target.kind,
            target.targetKey,
            rules,
            target.kind === "event" ? anchor : null,
            now,
          ),
    ],
  };
}

export function isReminderAction(action: string): boolean {
  return action.startsWith("reminder_");
}

export async function handleReminderAction(
  deps: SetupDeps,
  user: UserRecord,
  callback: InboundCallback,
  { action, payload }: UiAction,
): Promise<Reaction> {
  // Buttons sent before several reminders existed carry kind and targetKey.
  const legacy =
    typeof payload.targetKey === "string"
      ? {
          kind: payload.kind === "task" ? ("task" as const) : ("event" as const),
          targetKey: payload.targetKey,
          title: String(payload.title ?? "this"),
        }
      : undefined;
  const target = (payload.target as ReminderTarget | undefined) ?? legacy;
  if (!target || (target.kind !== "event" && target.kind !== "task") || action === "reminder_set") {
    return answer(callback, "This button is no longer valid. Open the item again.");
  }
  if (action === "reminder_menu")
    return combine(answer(callback), await reminderMenu(deps, user, target));
  const state = await reminderState(deps, user, target);
  if ("error" in state) return answer(callback, state.error);
  const now = deps.clock.now();
  const edit = callback.messageId;

  switch (action) {
    case "reminder_custom":
      return combine(
        answer(callback),
        guidedPrompt(
          deps,
          user,
          "reminder_input",
          { target },
          `Send reminders for ${target.title}, separated by commas, like 45m, 2h, 1 day before 6pm, or Thu 9am. They're added to the ones there; start with "only" to replace them.`,
        ),
      );
    case "reminder_default":
    case "reminder_none": {
      const rules =
        action === "reminder_none" ? [] : defaultRules(state.anchor, user.reminderMinutes);
      const next: ReminderState = {
        ...state,
        rules,
        setting: action === "reminder_none" ? { rules, anchor: null, updatedAt: now } : null,
      };
      return combine(
        answer(callback, action === "reminder_none" ? "No reminders." : "Back to the default."),
        write(user, target, action === "reminder_none" ? [] : "default", state.anchor, now),
        await reminderMenu(deps, user, target, edit, next),
      );
    }
    case "reminder_toggle": {
      const code = typeof payload.code === "string" ? payload.code : "";
      const rule = decodeRule(code);
      if (!rule) return answer(callback, "This button is no longer valid.");
      const has = state.rules.some((r) => encodeRule(r) === code);
      let rules: ReminderRule[];
      if (has) {
        rules = state.rules.filter((r) => encodeRule(r) !== code);
      } else {
        const problem = checkRuleText(rule, state.anchor, user, target.kind, now);
        if (problem) return answer(callback, problem.slice(0, 200));
        if (state.rules.length >= MAX_RULES) {
          return answer(callback, `Up to ${MAX_RULES} reminders each. Remove one first.`);
        }
        rules = [...state.rules, rule];
      }
      const next: ReminderState = {
        ...state,
        rules,
        setting: { rules, anchor: null, updatedAt: now },
      };
      return combine(
        answer(callback),
        write(user, target, rules, state.anchor, now),
        await reminderMenu(deps, user, target, edit, next),
      );
    }
    default:
      return answer(callback, "This button is no longer valid.");
  }
}

// --- Typed reminders ---------------------------------------------------------------------

export const TYPED_HINT = "Try 30m, 2h, 1 day before 6pm, 9am on the day, or Thu 9am.";

export type TypedOutcome =
  | { kind: "set"; rules: ReminderRule[]; notes: string[] }
  | { kind: "default" }
  | { kind: "error"; message: string };

/**
 * What typed reminders do to an item: added to its current ones, or replacing
 * them after "only". Entries that can't apply are named, never dropped quietly.
 */
export function typedReminders(
  user: UserRecord,
  kind: TargetKind,
  state: ReminderState,
  input: string,
  now: number,
): TypedOutcome {
  const replace = /^\s*only\s+/i.test(input);
  const text = input.replace(/^\s*only\s+/i, "");
  const parsed = parseReminders(text, localDateAt(now, user.timezone));
  switch (parsed.kind) {
    case "error": {
      const why =
        parsed.reason === "ambiguous"
          ? `"${parsed.part}" could be morning or evening; add am or pm.`
          : parsed.reason === "needs_time"
            ? `"${parsed.part}" needs a time, like 6pm.`
            : `I didn't recognize "${parsed.part}".`;
      return { kind: "error", message: `${why} ${TYPED_HINT}` };
    }
    case "none":
      return { kind: "set", rules: [], notes: [] };
    case "default":
      return { kind: "default" };
    case "entries": {
      const resolved = resolveEntries(parsed.entries, state.anchor, {
        now,
        timeZone: user.timezone,
        agendaHour: user.agendaHour,
      });
      const notes = resolved.problems.map(
        (p) => `Not added: ${p.source}: ${problemText(p.problem, kind, user.agendaHour)}.`,
      );
      if (resolved.rules.length === 0) {
        return { kind: "error", message: [...notes, TYPED_HINT].join("\n") };
      }
      const merged = mergeRules(replace ? [] : state.rules, resolved.rules);
      if (merged.overflow) {
        notes.push(`Up to ${MAX_RULES} reminders each: ${merged.overflow} not added.`);
      }
      return { kind: "set", rules: merged.rules, notes };
    }
  }
}

/** Typed reminders from the chat (Custom…, or a reply like "remind me 2h"). */
export async function applyTypedReminders(
  deps: SetupDeps,
  user: UserRecord,
  target: ReminderTarget,
  input: string,
): Promise<Reaction> {
  const state = await reminderState(deps, user, target);
  if ("error" in state) return message(user.privateChatId, state.error);
  const now = deps.clock.now();
  const outcome = typedReminders(user, target.kind, state, input, now);
  if (outcome.kind === "error") return message(user.privateChatId, outcome.message);
  const rules =
    outcome.kind === "default" ? defaultRules(state.anchor, user.reminderMinutes) : outcome.rules;
  const setting = outcome.kind === "default" ? null : { rules, anchor: null, updatedAt: now };
  const buttons = new ActionButtons(deps.ids, user.id, now);
  const summary = reminderSummary(user, target.title, { ...state, rules, setting });
  const notes = outcome.kind === "set" ? outcome.notes : [];
  return combine(
    write(user, target, outcome.kind === "default" ? "default" : rules, state.anchor, now),
    {
      ...about(target),
      replies: [
        keyboardMessage(
          user,
          [summary, ...notes].join("\n"),
          { inline_keyboard: [[buttons.button("Change", "reminder_menu", { target })]] },
          null,
        ),
      ],
      statements: (db, guard) => buttons.statements(db, guard),
    },
  );
}

/** The answer to Custom…. */
export async function handleReminderInput(
  deps: SetupDeps,
  user: UserRecord,
  input: InboundMessage,
  pending: PendingInput,
): Promise<Reaction> {
  const target = pending.payload.target as ReminderTarget | undefined;
  if (!target) {
    return {
      replies: message(user.privateChatId, "That question has expired. Open the item again.")
        .replies,
      statements: (db) => [clearPendingInputOfKindStatement(db, user.id, "reminder_input")],
    };
  }
  return applyTypedReminders(deps, user, target, input.text ?? "");
}

/** A short line for result messages and cards: "Reminders: 1 day before at 6pm; 1 hour before". */
export function reminderLine(
  user: UserRecord,
  state: Pick<ReminderState, "anchor" | "rules" | "setting">,
): string | null {
  if (!state.setting) return null;
  const labels = ruleLabels(state.rules, state.anchor, user.timezone);
  return `Reminders: ${labels.length ? labels.join("; ") : "none"}`;
}

// --- Mini App ---------------------------------------------------------------------------

/** What the Mini App shows and edits for one item's reminders. */
export interface ReminderPanel {
  /** The setting's version (0 for the default); writes must carry it. */
  version: number;
  /** The item has its own reminders rather than the default. */
  custom: boolean;
  /** Timed items take lead times; date-only deadlines need a day and time. */
  timed: boolean;
  items: { code: string; label: string }[];
  presets: { code: string; label: string; on: boolean }[];
  /** One line for the detail view: "1 hour before (default)", "None". */
  summary: string;
  max: number;
}

export function reminderPanel(user: UserRecord, state: ReminderState): ReminderPanel {
  const tz = user.timezone;
  const order = (r: ReminderRule) => ruleTime(r, state.anchor, tz) ?? 0;
  const items = [...state.rules]
    .sort((a, b) => order(a) - order(b))
    .map((r) => ({ code: encodeRule(r), label: ruleLabel(r, tz) }));
  const on = new Set(items.map((i) => i.code));
  const labels = items.map((i) => i.label);
  const summary = labels.length
    ? `${labels.join("; ")}${state.setting ? "" : " (default)"}`
    : state.anchor.kind === "date" && !state.setting
      ? `None; in the ${agendaLabel(user)} agenda on the day`
      : "None";
  return {
    version: state.setting?.updatedAt ?? 0,
    custom: state.setting !== null,
    timed: state.anchor.kind === "instant",
    items,
    presets: reminderPresets(state.anchor).map((p) => ({ ...p, on: on.has(p.code) })),
    summary,
    max: MAX_RULES,
  };
}

/**
 * An event of the user's, as a reminder target: read live, else from the
 * synced copy. Only calendars the user has are accepted.
 */
export async function loadEventTarget(
  deps: { db: D1Database; sourceFor: SourceFor },
  user: UserRecord,
  calendarId: string,
  eventId: string,
): Promise<ReminderTarget | null> {
  const calendars = await listStoredCalendars(deps.db, user.id);
  if (!calendars.some((c) => c.calendarId === calendarId)) return null;
  const source = await deps.sourceFor(user.id);
  if (source) {
    const live = await source.getEvent(calendarId, eventId);
    if (live.ok) {
      return live.value.status === "cancelled"
        ? null
        : eventTarget(calendarId, eventId, live.value.fields);
    }
    if (live.error.kind === "not_found") return null;
  }
  const cached = await findCachedEvent(deps.db, user.id, calendarId, eventId);
  return cached ? eventTarget(calendarId, eventId, cached.fields) : null;
}
