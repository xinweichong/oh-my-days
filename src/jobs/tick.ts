import { type RunnerDeps, runDueOperations } from "../application/operation-runner";
import type { Clock } from "../shared/clock";
import { logEvent } from "../shared/log";
import { purgeExpiredCallbackRefsStatement } from "../storage/callback-refs";
import { purgeFinishedInboxStatement, usersWithInboxWork } from "../storage/inbox";
import { expireConfirmationsStatement } from "../storage/operations";
import { purgeFinishedDeliveriesStatement, recoverExpiredDeliveries } from "../storage/outbox";
import { type DeliveryDeps, deliverDue } from "./delivery";
import { type InboxDeps, processUserInbox } from "./inbox";

/**
 * Bounds per scheduled invocation. Telegram sends are external subrequests, and
 * the Workers Free CPU limit applies per invocation, so work is paged across ticks.
 */
export const TICK_LIMITS = {
  inboxUsers: 10,
  inboxUpdatesPerUser: 5,
  operations: 10,
  deliveries: 20,
  purgeRows: 500,
} as const;

/** Finished inbox and outbox records are kept this long for deduplication and diagnosis. */
export const FINISHED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface TickDeps {
  db: D1Database;
  clock: Clock;
  inbox: InboxDeps;
  runner: RunnerDeps;
  delivery: DeliveryDeps;
}

export interface TickSummary {
  recoveredDeliveries: number;
  processedUpdates: number;
  attemptedOperations: number;
  attemptedDeliveries: number;
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
  const attemptedDeliveries = await deliverDue(deps.delivery, TICK_LIMITS.deliveries);

  const later = deps.clock.now();
  const cutoff = later - FINISHED_RETENTION_MS;
  await deps.db.batch([
    expireConfirmationsStatement(deps.db, later, TICK_LIMITS.purgeRows),
    purgeFinishedInboxStatement(deps.db, cutoff, TICK_LIMITS.purgeRows),
    purgeFinishedDeliveriesStatement(deps.db, cutoff, TICK_LIMITS.purgeRows),
    purgeExpiredCallbackRefsStatement(deps.db, cutoff, TICK_LIMITS.purgeRows),
  ]);

  const summary = {
    recoveredDeliveries,
    processedUpdates,
    attemptedOperations,
    attemptedDeliveries,
  };
  logEvent("tick.finished", { ...summary });
  return summary;
}
