import { type FollowUp, parseFollowUp } from "../domain/follow-up";
import type { Deadline } from "../domain/tasks";
import { localDateAt, wallPartsAt, zonedInstant } from "../domain/time";
import { listStoredCalendars } from "../storage/google";
import { type ItemRef, itemForReply } from "../storage/outbox";
import { findTask } from "../storage/tasks";
import type { UserRecord } from "../storage/users";
import type { InboundMessage } from "../telegram/update";
import {
  type EventFlowDeps,
  loadEvent,
  move,
  proposeEventDelete,
  proposePatch,
  restriction,
} from "./event-flow";
import { message, type Reaction } from "./reactions";
import { change, confirmPrompt, dueLabel } from "./task-flow";

/** How long the most recently discussed item stays the default target. */
export const LAST_ITEM_TTL_MS = 24 * 60 * 60_000;

/**
 * Follow-ups such as "Move it to 4pm" (spec §4). The target is the item in the
 * message being replied to; otherwise the single item most recently discussed.
 * Without a clear target nothing is changed. Follow-ups use the same
 * operations, confirmations, and Undo as the structured commands.
 */
export async function handleFollowUp(
  deps: EventFlowDeps,
  user: UserRecord,
  input: InboundMessage,
): Promise<Reaction | null> {
  const today = localDateAt(deps.clock.now(), user.timezone);
  const followUp = parseFollowUp(input.text ?? "", today);
  if (!followUp) return null;

  const target = await resolveTarget(deps, user, input);
  if (target === "unmapped") {
    return message(
      user.privateChatId,
      "I can't tell which event or task that message is about. Reply to the message about it, or open it from /event or /tasks.",
    );
  }
  if (!target) {
    return message(
      user.privateChatId,
      "Which event or task do you mean? Reply to the message about it, or open it from /event or /tasks.",
    );
  }
  const key = `msg:${input.messageId}`;
  return target.kind === "event"
    ? eventFollowUp(deps, user, target, followUp, key)
    : taskFollowUp(deps, user, target.taskId, followUp);
}

async function resolveTarget(
  deps: EventFlowDeps,
  user: UserRecord,
  input: InboundMessage,
): Promise<ItemRef | "unmapped" | null> {
  if (input.replyToMessageId !== null) {
    return (await itemForReply(deps.db, user.id, input.replyToMessageId)) ?? "unmapped";
  }
  const row = await deps.db
    .prepare("SELECT last_item, last_item_at FROM users WHERE id = ?")
    .bind(user.id)
    .first<{ last_item: string | null; last_item_at: number | null }>();
  if (!row?.last_item || (row.last_item_at ?? 0) < deps.clock.now() - LAST_ITEM_TTL_MS) return null;
  return JSON.parse(row.last_item) as ItemRef;
}

async function eventFollowUp(
  deps: EventFlowDeps,
  user: UserRecord,
  target: { calendarId: string; eventId: string },
  followUp: FollowUp,
  key: string,
): Promise<Reaction> {
  const event = await loadEvent(deps, user, target.calendarId, target.eventId);
  if (!event) return message(user.privateChatId, "I can't find that event anymore.");
  const calendar = (await listStoredCalendars(deps.db, user.id)).find(
    (c) => c.calendarId === target.calendarId,
  );
  const blocked = restriction(event, calendar);
  if (blocked) return message(user.privateChatId, blocked);

  switch (followUp.kind) {
    case "rename":
      return proposePatch(deps, user, event, { summary: followUp.title }, key);
    case "delete":
      return proposeEventDelete(deps, user, event, key);
    case "done":
      return message(
        user.privateChatId,
        `${event.fields.summary} is an event, so it can't be marked done.`,
      );
    case "move": {
      const { start, end } = event.fields;
      if ("date" in start) {
        if (followUp.time) {
          return message(
            user.privateChatId,
            `${event.fields.summary} is an all-day event. Send a date instead, like "move it to 9 Oct".`,
          );
        }
        return move(
          deps,
          user,
          {
            title: event.fields.summary,
            date: followUp.date ?? start.date,
            move: { calendarId: event.calendarId, eventId: event.eventId, start, end },
          },
          key,
        );
      }
      const startsAt = Date.parse(start.dateTime);
      const wall = wallPartsAt(startsAt, user.timezone);
      return move(
        deps,
        user,
        {
          title: event.fields.summary,
          date: followUp.date ?? localDateAt(startsAt, user.timezone),
          time:
            followUp.time ??
            `${String(wall.hour).padStart(2, "0")}:${String(wall.minute).padStart(2, "0")}`,
          move: { calendarId: event.calendarId, eventId: event.eventId, start, end },
        },
        key,
      );
    }
  }
}

async function taskFollowUp(
  deps: EventFlowDeps,
  user: UserRecord,
  taskId: string,
  followUp: FollowUp,
): Promise<Reaction> {
  const task = await findTask(deps.db, user.id, taskId);
  if (!task) return message(user.privateChatId, "I can't find that task anymore.");
  if (task.status !== "open" && followUp.kind !== "done") {
    return message(
      user.privateChatId,
      `${task.title} is ${task.status}. Reopen it from /tasks first.`,
    );
  }
  switch (followUp.kind) {
    case "done":
      if (task.status !== "open")
        return message(user.privateChatId, `${task.title} is already ${task.status}.`);
      return change(
        deps,
        user,
        task,
        { status: "completed" },
        { status: "open" },
        `Completed: ${task.title}.`,
      );
    case "rename":
      return change(
        deps,
        user,
        task,
        { title: followUp.title },
        { title: task.title },
        `Renamed: ${followUp.title}.`,
      );
    case "delete": {
      const marker =
        task.deadline.kind === "none" ? "" : " Its deadline is removed from Google Calendar.";
      return confirmPrompt(
        deps,
        user,
        `Cancel task: ${task.title}?${marker}`,
        "Cancel task",
        "task_cancel_confirm",
        {
          taskId: task.id,
          version: task.version,
        },
      );
    }
    case "move": {
      const today = localDateAt(deps.clock.now(), user.timezone);
      const deadline = movedDeadline(task.deadline, followUp, user, today);
      if ("error" in deadline) return message(user.privateChatId, deadline.error);
      return change(
        deps,
        user,
        task,
        { deadline },
        { deadline: task.deadline },
        `Deadline for ${task.title}: ${dueLabel(deadline, user.timezone).replace(/^Due /, "")}.`,
      );
    }
  }
}

/** A new deadline keeping whatever part (date or time) the follow-up didn't change. */
function movedDeadline(
  current: Deadline,
  followUp: { date: string | null; time: string | null },
  user: UserRecord,
  today: string,
): Deadline | { error: string } {
  const currentDate =
    current.kind === "date"
      ? current.date
      : current.kind === "datetime"
        ? localDateAt(current.at, user.timezone)
        : today;
  const date = followUp.date ?? currentDate;
  let time = followUp.time;
  if (!time && current.kind === "datetime") {
    const w = wallPartsAt(current.at, user.timezone);
    time = `${String(w.hour).padStart(2, "0")}:${String(w.minute).padStart(2, "0")}`;
  }
  if (!time) return { kind: "date", date };
  const at = zonedInstant(date, time, user.timezone);
  if (!at.ok)
    return { error: "That time doesn't exist on that day (clocks change). Send another time." };
  return { kind: "datetime", at: at.instant, timeZone: user.timezone };
}
