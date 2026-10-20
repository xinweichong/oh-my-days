import type { EventDisplay } from "../calendar/port";
import type { EventFields } from "../domain/calendar-event";
import {
  defaultRules,
  type ReminderAnchor,
  type ReminderRule,
  reminderTimes,
  ruleKeyPart,
} from "../domain/reminders";
import { reminderKeys } from "../domain/schedule";
import { type LocalDate, localDateAt } from "../domain/time";
import type { HorizonEvent, ReminderSetting, TargetKind } from "../storage/reminders";
import type { TaskRecord } from "../storage/tasks";
import type { UserRecord } from "../storage/users";

/**
 * Which reminders each event and task has, and when they fire (ADR 0008). Pure:
 * the reminder pass and /reminders load the inputs and decide what is due.
 */

const NO_DISPLAY: EventDisplay = { location: null, callUrl: null, htmlLink: null };

export interface PlannedEvent {
  calendarId: string;
  eventId: string;
  summary: string;
  /** Start and end for the message; the anchor alone when the event isn't known. */
  fields: Pick<EventFields, "start" | "end"> | null;
  anchor: ReminderAnchor;
  display: EventDisplay;
  /** From the horizon (freshly listed) rather than the start kept with its reminders. */
  fromHorizon: boolean;
}

export interface PlannedReminder {
  /** The reminder_log key: one logical reminder, sent or skipped at most once. */
  key: string;
  at: number;
  rule: ReminderRule;
  /** When the item's own reminders were set; null for the default. */
  setAt: number | null;
  event?: PlannedEvent;
  task?: TaskRecord;
}

export interface PlanInput {
  user: Pick<UserRecord, "timezone" | "reminderMinutes">;
  now: number;
  settings: Record<TargetKind, Map<string, ReminderSetting>>;
  /** Upcoming timed occurrences (declined ones included; they are skipped). */
  horizon: readonly HorizonEvent[];
  /** Open tasks to consider; snoozed ones get no deadline reminders. */
  tasks: readonly TaskRecord[];
  /** What is known of events with their own reminders outside the horizon. */
  known?: ReadonlyMap<string, { summary: string; fields: Pick<EventFields, "start" | "end"> }>;
}

export function eventTargetKey(calendarId: string, eventId: string): string {
  return `${calendarId}/${eventId}`;
}

export function splitEventKey(key: string): [string, string] {
  const index = key.lastIndexOf("/");
  return [key.slice(0, index), key.slice(index + 1)];
}

function anchorPart(anchor: ReminderAnchor): number | LocalDate {
  return anchor.kind === "instant" ? anchor.at : anchor.date;
}

/** Whether an item at this time is still ahead (a date-only one: until its day ends). */
function ahead(anchor: ReminderAnchor, now: number, timeZone: string): boolean {
  return anchor.kind === "instant" ? anchor.at > now : anchor.date >= localDateAt(now, timeZone);
}

/** Every reminder of items still ahead, including any already due; earliest first. */
export function planReminders(input: PlanInput): PlannedReminder[] {
  const { user, now, settings } = input;
  const tz = user.timezone;
  const out: PlannedReminder[] = [];
  const add = (
    anchor: ReminderAnchor,
    setting: ReminderSetting | undefined,
    keyFor: (part: string) => string,
    item: Pick<PlannedReminder, "event" | "task">,
  ) => {
    const rules = setting ? setting.rules : defaultRules(anchor, user.reminderMinutes);
    for (const { rule, at } of reminderTimes(rules, anchor, tz)) {
      out.push({
        key: keyFor(ruleKeyPart(rule)),
        at,
        rule,
        setAt: setting?.updatedAt ?? null,
        ...item,
      });
    }
  };

  const listed = new Set<string>();
  for (const e of input.horizon) {
    const target = eventTargetKey(e.calendarId, e.eventId);
    listed.add(target);
    if (e.declined || e.startsAt <= now) continue;
    const anchor: ReminderAnchor = { kind: "instant", at: e.startsAt };
    add(
      anchor,
      settings.event.get(target),
      (part) => reminderKeys.event(e.calendarId, e.eventId, e.startsAt, part),
      {
        event: {
          calendarId: e.calendarId,
          eventId: e.eventId,
          summary: e.summary,
          fields: {
            start: { dateTime: new Date(e.startsAt).toISOString(), timeZone: tz },
            end: { dateTime: new Date(e.endsAt).toISOString(), timeZone: tz },
          },
          anchor,
          display: e.display,
          fromHorizon: true,
        },
      },
    );
  }

  // Events with their own reminders beyond the horizon (or all-day): from the
  // start kept with the reminders, re-read from Google before sending.
  for (const [target, setting] of settings.event) {
    const anchor = setting.anchor;
    if (listed.has(target) || !anchor || !ahead(anchor, now, tz)) continue;
    const [calendarId, eventId] = splitEventKey(target);
    const known = input.known?.get(target);
    add(
      anchor,
      setting,
      (part) => reminderKeys.event(calendarId, eventId, anchorPart(anchor), part),
      {
        event: {
          calendarId,
          eventId,
          summary: known?.summary ?? "An event",
          fields: known?.fields ?? null,
          anchor,
          display: NO_DISPLAY,
          fromHorizon: false,
        },
      },
    );
  }

  for (const task of input.tasks) {
    if (task.status !== "open" || (task.snoozedUntil !== null && task.snoozedUntil > now)) continue;
    const anchor: ReminderAnchor | null =
      task.deadline.kind === "datetime"
        ? { kind: "instant", at: task.deadline.at }
        : task.deadline.kind === "date"
          ? { kind: "date", date: task.deadline.date }
          : null;
    if (!anchor || !ahead(anchor, now, tz)) continue;
    add(
      anchor,
      settings.task.get(task.id),
      (part) => reminderKeys.taskDue(task.id, anchorPart(anchor), part),
      { task },
    );
  }
  return out.sort((a, b) => a.at - b.at);
}
