import type { IdGenerator } from "../shared/ids";
import { isReplaySafe, type TelegramCall, type TelegramMethod } from "../telegram/api";
import type { Guard } from "./guard";

export interface OutboundMessage {
  /** Unique per user. Re-enqueueing the same key is a no-op. */
  logicalKey: string;
  call: TelegramCall;
}

export interface ClaimedDelivery {
  id: string;
  userId: string;
  attempts: number;
  leaseToken: string;
  call: TelegramCall;
}

export function enqueueStatement(
  db: D1Database,
  ids: IdGenerator,
  userId: string,
  message: OutboundMessage,
  now: number,
  guard: Guard,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO telegram_outbox
         (id, user_id, logical_key, method, payload, status, due_at, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, 'pending', ?, ?, ? WHERE ${guard.sql}
       ON CONFLICT (user_id, logical_key) DO NOTHING`,
    )
    .bind(
      ids.next(),
      userId,
      message.logicalKey,
      message.call.method,
      JSON.stringify(message.call.params),
      now,
      now,
      now,
      ...guard.params,
    );
}

/**
 * Claims the oldest due delivery, optionally for one user. A user with a
 * delivery in flight is skipped so their messages stay in order.
 */
export async function claimNextDelivery(
  db: D1Database,
  leaseToken: string,
  now: number,
  leaseMs: number,
  userId: string | null,
): Promise<ClaimedDelivery | null> {
  const row = await db
    .prepare(
      `UPDATE telegram_outbox
       SET status = 'sending', attempts = attempts + 1, lease_token = ?1, lease_expires_at = ?2,
           updated_at = ?3
       WHERE id = (
         SELECT o.id FROM telegram_outbox o
         WHERE o.status = 'pending' AND o.due_at <= ?3 AND (?4 IS NULL OR o.user_id = ?4)
           AND NOT EXISTS (
             SELECT 1 FROM telegram_outbox s WHERE s.user_id = o.user_id AND s.status = 'sending')
         ORDER BY o.due_at, o.rowid LIMIT 1)
       RETURNING id, user_id, attempts, method, payload`,
    )
    .bind(leaseToken, now + leaseMs, now, userId)
    .first<{
      id: string;
      user_id: string;
      attempts: number;
      method: TelegramMethod;
      payload: string;
    }>();
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    attempts: row.attempts,
    leaseToken,
    call: { method: row.method, params: JSON.parse(row.payload) } as TelegramCall,
  };
}

export type DeliveryOutcome =
  | { status: "sent"; providerMessageId: number | null }
  | { status: "retry"; dueAt: number; errorClass: string }
  | { status: "unknown" | "failed"; errorClass: string };

/** Records the outcome of a claimed delivery. Returns false if the lease was lost. */
export async function finishDelivery(
  db: D1Database,
  claim: ClaimedDelivery,
  outcome: DeliveryOutcome,
  now: number,
): Promise<boolean> {
  const where = "WHERE id = ? AND lease_token = ?";
  const lease = [claim.id, claim.leaseToken];
  let statement: D1PreparedStatement;
  switch (outcome.status) {
    case "sent":
      statement = db
        .prepare(
          `UPDATE telegram_outbox SET status = 'sent', payload = NULL, lease_token = NULL,
             lease_expires_at = NULL, provider_message_id = ?, error_class = NULL, updated_at = ?
           ${where}`,
        )
        .bind(outcome.providerMessageId, now, ...lease);
      break;
    case "retry":
      statement = db
        .prepare(
          `UPDATE telegram_outbox SET status = 'pending', lease_token = NULL,
             lease_expires_at = NULL, due_at = ?, error_class = ?, updated_at = ?
           ${where}`,
        )
        .bind(outcome.dueAt, outcome.errorClass, now, ...lease);
      break;
    default:
      statement = db
        .prepare(
          `UPDATE telegram_outbox SET status = ?, payload = NULL, lease_token = NULL,
             lease_expires_at = NULL, error_class = ?, updated_at = ?
           ${where}`,
        )
        .bind(outcome.status, outcome.errorClass, now, ...lease);
  }
  const result = await statement.run();
  return result.meta.changes === 1;
}

/**
 * Releases deliveries whose worker vanished mid-send. Replay-safe calls return to
 * pending; a sendMessage may already have been delivered, so it becomes unknown.
 */
export async function recoverExpiredDeliveries(db: D1Database, now: number): Promise<number> {
  const replaySafe = (["sendMessage", "editMessageText", "answerCallbackQuery"] as const)
    .filter(isReplaySafe)
    .map((m) => `'${m}'`)
    .join(", ");
  const result = await db
    .prepare(
      `UPDATE telegram_outbox
       SET status = CASE WHEN method IN (${replaySafe}) THEN 'pending' ELSE 'unknown' END,
           payload = CASE WHEN method IN (${replaySafe}) THEN payload ELSE NULL END,
           error_class = CASE WHEN method IN (${replaySafe}) THEN error_class ELSE 'lease_expired' END,
           lease_token = NULL, lease_expires_at = NULL, updated_at = ?1
       WHERE status = 'sending' AND lease_expires_at <= ?1`,
    )
    .bind(now)
    .run();
  return result.meta.changes;
}

export function purgeFinishedDeliveriesStatement(
  db: D1Database,
  olderThan: number,
  limit: number,
): D1PreparedStatement {
  return db
    .prepare(
      `DELETE FROM telegram_outbox WHERE id IN (
         SELECT id FROM telegram_outbox
         WHERE status IN ('sent', 'unknown', 'failed') AND updated_at < ? LIMIT ?)`,
    )
    .bind(olderThan, limit);
}
