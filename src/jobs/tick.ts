import { type RunnerDeps, runDueOperations } from "../application/operation-runner";
import { materializeSeries } from "../application/series";
import type { Clock } from "../shared/clock";
import { logEvent } from "../shared/log";
import { purgeExpiredCallbackRefsStatement } from "../storage/callback-refs";
import { purgeExpiredAuthStatements } from "../storage/google";
import { purgeFinishedInboxStatement, usersWithInboxWork } from "../storage/inbox";
import { purgeExpiredInteractionsStatements } from "../storage/interactions";
import {
  expireConfirmationsStatement,
  purgeFinishedOperationsStatements,
} from "../storage/operations";
import { purgeFinishedDeliveriesStatement, recoverExpiredDeliveries } from "../storage/outbox";
import { purgeOldReminderStatements } from "../storage/reminders";
import { syncBotCommands } from "./bot-commands";
import {
  refreshCalendarLists,
  type SyncDeps,
  scheduleCalendarsStatements,
  syncDueCalendars,
} from "./calendar-sync";
import { type DeliveryDeps, deliverDue } from "./delivery";
import { refreshHorizons } from "./horizon";
import { type InboxDeps, processUserInbox } from "./inbox";
import { type ReminderDeps, runReminders } from "./reminders";

/**
 * Bounds per scheduled invocation. Telegram sends are external subrequests, and
 * the Workers Free CPU limit applies per invocation, so work is paged across ticks.
 */
export const TICK_LIMITS = {
  inboxUsers: 10,
  inboxUpdatesPerUser: 5,
  operations: 10,
  /** Calendars synchronized per tick; each may fetch up to MAX_PAGES_PER_RUN pages. */
  calendars: 4,
  calendarLists: 2,
  horizons: 2,
  series: 5,
  reminderUsers: 20,
  deliveries: 20,
  purgeRows: 500,
} as const;

/** Finished inbox and outbox records are kept this long for deduplication and diagnosis. */
export const FINISHED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** Finished operations (request snapshots) are kept this long (privacy policy). */
export const OPERATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface TickDeps {
  db: D1Database;
  clock: Clock;
  inbox: InboxDeps;
  runner: RunnerDeps;
  delivery: DeliveryDeps;
  sync: SyncDeps;
  reminders: ReminderDeps;
}

export interface TickSummary {
  recoveredDeliveries: number;
  processedUpdates: number;
  attemptedOperations: number;
  attemptedDeliveries: number;
  syncedCalendars: number;
  reminders: number;
}

/** One scheduled tick. Interactive work comes before maintenance. */
export async function runTick(deps: TickDeps): Promise<TickSummary> {
  const now = deps.clock.now();
  const recoveredDeliveries = await recoverExpiredDeliveries(deps.db, now);

  let processedUpdates = 0;
  for (const userId of await usersWithInboxWork(deps.db, now, TICK_LIMITS.inboxUsers)) {
    processedUpdates += await processUserInbox(deps.inbox, userId, TICK_LIMITS.inboxUpdatesPerUser);
  }

  const attemptedOperations = await runDueOperations(deps.runner, TICK_LIMITS.operations);
  // New occurrences are created before reminders and agendas look at tasks.
  await materializeSeries(deps.reminders, TICK_LIMITS.series);

  // Sync before delivery, so messages it produces (e.g. conflicts) go out now.
  await deps.db.batch(scheduleCalendarsStatements(deps.db, deps.clock.now()));
  const syncedCalendars = await syncDueCalendars(deps.sync, TICK_LIMITS.calendars);
  await refreshCalendarLists(deps.sync, TICK_LIMITS.calendarLists);

  // Reminders and agendas come before delivery so they go out in this tick.
  await refreshHorizons(deps.reminders, TICK_LIMITS.horizons);
  const reminders = await runReminders(deps.reminders, TICK_LIMITS.reminderUsers);

  const attemptedDeliveries = await deliverDue(deps.delivery, TICK_LIMITS.deliveries);

  // Maintenance: keep Telegram's command menu in step with the deployed code.
  await syncBotCommands({ db: deps.db, clock: deps.clock, telegram: deps.delivery.telegram });

  const later = deps.clock.now();
  const cutoff = later - FINISHED_RETENTION_MS;
  await deps.db.batch([
    expireConfirmationsStatement(deps.db, later, TICK_LIMITS.purgeRows),
    purgeFinishedInboxStatement(deps.db, cutoff, TICK_LIMITS.purgeRows),
    purgeFinishedDeliveriesStatement(deps.db, cutoff, TICK_LIMITS.purgeRows),
    purgeExpiredCallbackRefsStatement(deps.db, cutoff, TICK_LIMITS.purgeRows),
    ...purgeFinishedOperationsStatements(
      deps.db,
      later - OPERATION_RETENTION_MS,
      TICK_LIMITS.purgeRows,
    ),
    ...purgeExpiredAuthStatements(deps.db, later, TICK_LIMITS.purgeRows),
    ...purgeExpiredInteractionsStatements(deps.db, later, TICK_LIMITS.purgeRows),
    ...purgeOldReminderStatements(deps.db, later - OPERATION_RETENTION_MS, TICK_LIMITS.purgeRows),
  ]);

  const summary = {
    recoveredDeliveries,
    processedUpdates,
    attemptedOperations,
    attemptedDeliveries,
    syncedCalendars,
    reminders,
  };
  logEvent("tick.finished", { ...summary });
  return summary;
}
