import type { InboundUpdate } from "../telegram/update";
import type { Guard } from "./guard";

export type InboxStatus = "pending" | "processing" | "processed" | "failed";

export interface ClaimedUpdate {
  updateId: number;
  userId: string;
  attempts: number;
  leaseToken: string;
  update: InboundUpdate;
}

/**
 * Persists an accepted update for an active user. Deduplicates on update_id:
 * a redelivered update is ignored, whatever its processing state.
 */
export function insertInboxStatement(
  db: D1Database,
  update: InboundUpdate,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO telegram_inbox (update_id, user_id, kind, payload, status, received_at)
       SELECT ?, id, ?, ?, 'pending', ? FROM users
       WHERE telegram_user_id = ? AND status = 'active'
       ON CONFLICT (update_id) DO NOTHING`,
    )
    .bind(update.updateId, update.kind, JSON.stringify(update), now, update.fromId);
}

/**
 * Claims the user's oldest unfinished update, unless another update for the same
 * user is being processed under a live lease. This serializes each user's
 * conversation while allowing different users to proceed concurrently.
 */
export async function claimNextUpdate(
  db: D1Database,
  userId: string,
  leaseToken: string,
  now: number,
  leaseMs: number,
): Promise<ClaimedUpdate | null> {
  const row = await db
    .prepare(
      `UPDATE telegram_inbox
       SET status = 'processing', attempts = attempts + 1, lease_token = ?1, lease_expires_at = ?2
       WHERE update_id = (
           SELECT update_id FROM telegram_inbox
           WHERE user_id = ?3
             AND (status = 'pending' OR (status = 'processing' AND lease_expires_at <= ?4))
           ORDER BY update_id LIMIT 1)
         AND NOT EXISTS (
           SELECT 1 FROM telegram_inbox
           WHERE user_id = ?3 AND status = 'processing' AND lease_expires_at > ?4)
       RETURNING update_id, user_id, attempts, payload`,
    )
    .bind(leaseToken, now + leaseMs, userId, now)
    .first<{ update_id: number; user_id: string; attempts: number; payload: string }>();
  if (!row) return null;
  return {
    updateId: row.update_id,
    userId: row.user_id,
    attempts: row.attempts,
    leaseToken,
    update: JSON.parse(row.payload) as InboundUpdate,
  };
}

/** Guard that holds while the claim is still owned by this lease. */
export function inboxLeaseGuard(claim: ClaimedUpdate): Guard {
  return {
    sql: "EXISTS (SELECT 1 FROM telegram_inbox WHERE update_id = ? AND lease_token = ?)",
    params: [claim.updateId, claim.leaseToken],
  };
}

/**
 * Finishes a claim and drops its payload. Must be the last statement of the
 * batch that carries the claim's effects (see Guard).
 */
export function finishUpdateStatement(
  db: D1Database,
  claim: ClaimedUpdate,
  status: "processed" | "failed",
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE telegram_inbox
       SET status = ?, payload = NULL, lease_token = NULL, lease_expires_at = NULL, finished_at = ?
       WHERE update_id = ? AND lease_token = ?`,
    )
    .bind(status, now, claim.updateId, claim.leaseToken);
}

/** Users with inbox work that is pending or whose lease expired. */
export async function usersWithInboxWork(
  db: D1Database,
  now: number,
  limit: number,
): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT DISTINCT user_id FROM telegram_inbox
       WHERE status = 'pending' OR (status = 'processing' AND lease_expires_at <= ?)
       LIMIT ?`,
    )
    .bind(now, limit)
    .all<{ user_id: string }>();
  return results.map((r) => r.user_id);
}

/** Deletes finished deduplication records past the retention horizon, in bounded batches. */
export function purgeFinishedInboxStatement(
  db: D1Database,
  olderThan: number,
  limit: number,
): D1PreparedStatement {
  return db
    .prepare(
      `DELETE FROM telegram_inbox WHERE update_id IN (
         SELECT update_id FROM telegram_inbox
         WHERE status IN ('processed', 'failed') AND finished_at < ? LIMIT ?)`,
    )
    .bind(olderThan, limit);
}
