import { eventOperationHandlers } from "../../src/application/event-operations";
import type { RunnerDeps } from "../../src/application/operation-runner";
import type { Proposal } from "../../src/application/operation-types";
import { registry } from "../../src/application/operation-types";
import { type PreparedProposal, prepareProposal } from "../../src/application/proposals";
import type { EventFields } from "../../src/domain/calendar-event";
import { unguarded } from "../../src/storage/guard";
import { enqueueStatement } from "../../src/storage/outbox";
import { findUserById, type UserRecord, upsertUserStatement } from "../../src/storage/users";
import { FakeCalendar } from "./fake-calendar";
import { FakeClock, SequentialIds } from "./fakes";
import { userIdFor } from "./telegram";

export const CAL = "primary-cal";

export function dinner(): EventFields {
  return {
    summary: "Dinner",
    start: { dateTime: "2026-09-25T19:00:00+08:00", timeZone: "Asia/Singapore" },
    end: { dateTime: "2026-09-25T20:00:00+08:00", timeZone: "Asia/Singapore" },
  };
}

export const at = (hour: number) => ({
  dateTime: `2026-09-25T${String(hour).padStart(2, "0")}:00:00+08:00`,
  timeZone: "Asia/Singapore",
});

export interface Harness extends RunnerDeps {
  clock: FakeClock;
  ids: SequentialIds;
  calendars: Map<string, FakeCalendar>;
}

/** Runner dependencies with one FakeCalendar per user. */
export function harness(db: D1Database): Harness {
  const calendars = new Map<string, FakeCalendar>();
  return {
    db,
    clock: new FakeClock(),
    ids: new SequentialIds("op"),
    random: () => 0.5,
    handlers: registry(...eventOperationHandlers),
    calendars,
    calendarFor: async (userId) => calendars.get(userId) ?? null,
  };
}

export async function createUser(
  h: Harness,
  telegramId: number,
  withCalendar = true,
): Promise<UserRecord> {
  await upsertUserStatement(h.db, h.ids, telegramId, telegramId, h.clock.now()).run();
  const user = await findUserById(h.db, await userIdFor(h.db, telegramId));
  if (!user) throw new Error("user missing");
  if (withCalendar) h.calendars.set(user.id, new FakeCalendar());
  return user;
}

export function calendarOf(h: Harness, user: UserRecord): FakeCalendar {
  const calendar = h.calendars.get(user.id);
  if (!calendar) throw new Error("no calendar");
  return calendar;
}

/** Commits a proposal as the inbox would, including its confirmation prompt. */
export async function submit(
  h: Harness,
  user: UserRecord,
  proposal: Proposal,
): Promise<PreparedProposal> {
  const prepared = await prepareProposal(h, user, proposal);
  await h.db.batch([
    ...prepared.statements(h.db, unguarded),
    ...prepared.replies.map((call, i) =>
      enqueueStatement(
        h.db,
        h.ids,
        user.id,
        { logicalKey: `test:${prepared.operationId}:${i}`, call },
        h.clock.now(),
        unguarded,
      ),
    ),
  ]);
  return prepared;
}

export interface SentMessage {
  text: string;
  buttons: { text: string; token: string }[];
}

/** Messages queued for the user, oldest first. */
export async function messages(db: D1Database, userId: string): Promise<SentMessage[]> {
  const { results } = await db
    .prepare(
      "SELECT payload FROM telegram_outbox WHERE user_id = ? AND method = 'sendMessage' ORDER BY rowid",
    )
    .bind(userId)
    .all<{ payload: string }>();
  return results.map((r) => {
    const params = JSON.parse(r.payload) as {
      text: string;
      reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] };
    };
    return {
      text: params.text,
      buttons: (params.reply_markup?.inline_keyboard ?? [])
        .flat()
        .map((b) => ({ text: b.text, token: b.callback_data.replace(/^o:/, "") })),
    };
  });
}

export async function operationRow(
  db: D1Database,
  operationId: string,
): Promise<{
  status: string;
  attempts: number;
  error_class: string | null;
  outcome_unknown: number;
}> {
  const row = await db
    .prepare("SELECT status, attempts, error_class, outcome_unknown FROM operations WHERE id = ?")
    .bind(operationId)
    .first<{
      status: string;
      attempts: number;
      error_class: string | null;
      outcome_unknown: number;
    }>();
  if (!row) throw new Error("operation missing");
  return row;
}
