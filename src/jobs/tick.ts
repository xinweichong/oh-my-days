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
import { evaluateSyncHealth } from "./sync-health";

/**
 * Bounds per scheduled invocation. Telegram sends are external subrequests, and
 * the Workers Free CPU limit applies per invocation, so work is paged across ticks.
 */
export const TICK_LIMITS = {
  inboxUsers: 10,
  inboxUpdatesPerUser: 5,
  operations: 10,
  /** Calendars synchronized per tick; parsing event pages is the heaviest CPU work. */
  calendars: 1,
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

  // At most one heavy job per tick (one calendar's sync, frequent maintenance,
  // or cleanup), so each invocation stays inside the Workers Free CPU limit
  // (measured in docs/capacity.md). Deferred jobs run on following ticks.
  const syncedCalendars = await syncDueCalendars(deps.sync, TICK_LIMITS.calendars);
  const due =
    syncedCalendars > 0
      ? { frequent: false, cleanup: false }
      : await claimMaintenance(deps.db, now);

  if (due.frequent) {
    await deps.db.batch(scheduleCalendarsStatements(deps.db, deps.clock.now()));
    await refreshCalendarLists(deps.sync, TICK_LIMITS.calendarLists);
    await evaluateSyncHealth(deps.reminders);
  }

  // Reminders and agendas come before delivery so they go out in this tick.
  await refreshHorizons(deps.reminders, TICK_LIMITS.horizons);
  const reminders = await runReminders(deps.reminders, TICK_LIMITS.reminderUsers);

  const attemptedDeliveries = await deliverDue(deps.delivery, TICK_LIMITS.deliveries);

  // Maintenance: keep Telegram's command menu in step with the deployed code.
  if (due.frequent) {
    await syncBotCommands({ db: deps.db, clock: deps.clock, telegram: deps.delivery.telegram });
  }

  const later = deps.clock.now();
  if (due.frequent) await expireConfirmationsStatement(deps.db, later, TICK_LIMITS.purgeRows).run();
  if (due.cleanup) await purge(deps.db, later);

  const summary = {
    recoveredDeliveries,
    processedUpdates,
    attemptedOperations,
    attemptedDeliveries,
    syncedCalendars,
    reminders,
  };
  logEvent("tick.finished", { ...summary, frequent: due.frequent, cleanup: due.cleanup });
  return summary;
}

/** Interval of frequent maintenance (calendar lists, sync health, menu, expiry). */
export const FREQUENT_MAINTENANCE_MS = 5 * 60_000;
/** Interval of retention cleanup. */
export const CLEANUP_MS = 30 * 60_000;

/**
 * Decides which periodic groups are due, and records them as run. Overlapping
 * ticks may both run a group; every group is idempotent.
 */
async function claimMaintenance(
  db: D1Database,
  now: number,
): Promise<{ frequent: boolean; cleanup: boolean }> {
  const { results } = await db
    .prepare(
      "SELECT key, value FROM app_state WHERE key IN ('maintenance:frequent', 'maintenance:cleanup')",
    )
    .all<{ key: string; value: string }>();
  const last = (key: string) => Number(results.find((r) => r.key === key)?.value ?? 0);
  const frequent = now - last("maintenance:frequent") >= FREQUENT_MAINTENANCE_MS;
  // Cleanup waits for a tick without frequent maintenance.
  const cleanup = !frequent && now - last("maintenance:cleanup") >= CLEANUP_MS;
  const record = (key: string) =>
    db
      .prepare(
        `INSERT INTO app_state (key, value, updated_at) VALUES (?1, ?2, ?2)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .bind(key, String(now));
  const writes = [
    ...(frequent ? [record("maintenance:frequent")] : []),
    ...(cleanup ? [record("maintenance:cleanup")] : []),
  ];
  if (writes.length) await db.batch(writes);
  return { frequent, cleanup };
}

async function purge(db: D1Database, later: number): Promise<void> {
  const cutoff = later - FINISHED_RETENTION_MS;
  await db.batch([
    purgeFinishedInboxStatement(db, cutoff, TICK_LIMITS.purgeRows),
    purgeFinishedDeliveriesStatement(db, cutoff, TICK_LIMITS.purgeRows),
    purgeExpiredCallbackRefsStatement(db, cutoff, TICK_LIMITS.purgeRows),
    ...purgeFinishedOperationsStatements(db, later - OPERATION_RETENTION_MS, TICK_LIMITS.purgeRows),
    ...purgeExpiredAuthStatements(db, later, TICK_LIMITS.purgeRows),
    ...purgeExpiredInteractionsStatements(db, later, TICK_LIMITS.purgeRows),
    ...purgeOldReminderStatements(db, later - OPERATION_RETENTION_MS, TICK_LIMITS.purgeRows),
  ]);
}
