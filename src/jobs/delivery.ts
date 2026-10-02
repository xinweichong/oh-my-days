import { type BackoffPolicy, retryDelayMs } from "../domain/retry";
import type { Clock } from "../shared/clock";
import type { IdGenerator } from "../shared/ids";
import { logEvent } from "../shared/log";
import { claimNextDelivery, type DeliveryOutcome, finishDelivery } from "../storage/outbox";
import { isReplaySafe } from "../telegram/api";
import type { TelegramClient, TelegramResult } from "../telegram/client";

export const DELIVERY_LEASE_MS = 30_000;
export const DELIVERY_MAX_ATTEMPTS = 5;
const BACKOFF: BackoffPolicy = { baseMs: 2_000, maxMs: 5 * 60_000 };

export interface DeliveryDeps {
  db: D1Database;
  clock: Clock;
  ids: IdGenerator;
  telegram: TelegramClient;
  random: () => number;
}

/**
 * Sends up to `limit` due messages, optionally for a single user. Each send is
 * one external subrequest, so callers bound `limit` by the invocation budget.
 */
export async function deliverDue(
  deps: DeliveryDeps,
  limit: number,
  userId: string | null = null,
): Promise<number> {
  let attempted = 0;
  while (attempted < limit) {
    const claim = await claimNextDelivery(
      deps.db,
      deps.ids.next(),
      deps.clock.now(),
      DELIVERY_LEASE_MS,
      userId,
    );
    if (!claim) break;
    attempted++;
    const result = await deps.telegram.call(claim.call);
    const outcome = toOutcome(result, claim.call.method, claim.attempts, deps);
    await finishDelivery(deps.db, claim, outcome, deps.clock.now());
    if (outcome.status !== "sent") {
      logEvent("delivery.not_sent", {
        deliveryId: claim.id,
        status: outcome.status,
        errorClass: outcome.errorClass,
      });
    }
  }
  return attempted;
}

function toOutcome(
  result: TelegramResult,
  method: Parameters<typeof isReplaySafe>[0],
  attempts: number,
  deps: DeliveryDeps,
): DeliveryOutcome {
  switch (result.kind) {
    case "ok":
      return { status: "sent", providerMessageId: result.messageId };
    case "permanent":
      return { status: "failed", errorClass: result.errorClass };
    case "unknown":
      if (!isReplaySafe(method)) return { status: "unknown", errorClass: result.errorClass };
      return retryOrFail(attempts, result.errorClass, null, deps);
    case "retryable":
      return retryOrFail(attempts, result.errorClass, result.retryAfterMs, deps);
  }
}

function retryOrFail(
  attempts: number,
  errorClass: string,
  hintMs: number | null,
  deps: DeliveryDeps,
): DeliveryOutcome {
  if (attempts >= DELIVERY_MAX_ATTEMPTS) return { status: "failed", errorClass };
  const delay = retryDelayMs(attempts, BACKOFF, deps.random, hintMs);
  return { status: "retry", dueAt: deps.clock.now() + delay, errorClass };
}
