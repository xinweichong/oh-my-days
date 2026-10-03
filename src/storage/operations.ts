import type { OperationStatus } from "../domain/operation-status";
import type { Guard } from "./guard";

export interface OperationRecord {
  id: string;
  userId: string;
  kind: string;
  idempotencyKey: string;
  intent: unknown;
  preview: unknown;
  previewHash: string | null;
  confirmationExpiresAt: number | null;
  status: OperationStatus;
  attempts: number;
  nextAttemptAt: number | null;
  outcomeUnknown: boolean;
  result: unknown;
  errorClass: string | null;
}

export interface ClaimedOperation extends OperationRecord {
  leaseToken: string;
}

interface OperationRow {
  id: string;
  user_id: string;
  kind: string;
  idempotency_key: string;
  intent: string;
  preview: string | null;
  preview_hash: string | null;
  confirmation_expires_at: number | null;
  status: OperationStatus;
  attempts: number;
  next_attempt_at: number | null;
  outcome_unknown: number;
  result: string | null;
  error_class: string | null;
}

const COLUMNS = `id, user_id, kind, idempotency_key, intent, preview, preview_hash,
  confirmation_expires_at, status, attempts, next_attempt_at, outcome_unknown, result, error_class`;

function toRecord(row: OperationRow): OperationRecord {
  return {
    id: row.id,
    userId: row.user_id,
    kind: row.kind,
    idempotencyKey: row.idempotency_key,
    intent: JSON.parse(row.intent),
    preview: row.preview === null ? null : JSON.parse(row.preview),
    previewHash: row.preview_hash,
    confirmationExpiresAt: row.confirmation_expires_at,
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    outcomeUnknown: row.outcome_unknown === 1,
    result: row.result === null ? null : JSON.parse(row.result),
    errorClass: row.error_class,
  };
}

export interface NewOperation {
  id: string;
  userId: string;
  kind: string;
  idempotencyKey: string;
  intent: unknown;
  status: "awaiting_confirmation" | "ready";
  preview: unknown;
  previewHash: string | null;
  confirmationExpiresAt: number | null;
}

/** Inserts unless the user already has an operation with this idempotency key. */
export function insertOperationStatement(
  db: D1Database,
  op: NewOperation,
  now: number,
  guard: Guard,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO operations (id, user_id, kind, idempotency_key, intent, preview, preview_hash,
         confirmation_expires_at, status, next_attempt_at, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard.sql}
       ON CONFLICT (user_id, idempotency_key) DO NOTHING`,
    )
    .bind(
      op.id,
      op.userId,
      op.kind,
      op.idempotencyKey,
      JSON.stringify(op.intent),
      op.preview === null ? null : JSON.stringify(op.preview),
      op.previewHash,
      op.confirmationExpiresAt,
      op.status,
      op.status === "ready" ? now : null,
      now,
      now,
      ...guard.params,
    );
}

export async function findOperation(
  db: D1Database,
  userId: string,
  operationId: string,
): Promise<OperationRecord | null> {
  const row = await db
    .prepare(`SELECT ${COLUMNS} FROM operations WHERE id = ? AND user_id = ?`)
    .bind(operationId, userId)
    .first<OperationRow>();
  return row ? toRecord(row) : null;
}

export async function findOperationByKey(
  db: D1Database,
  userId: string,
  idempotencyKey: string,
): Promise<OperationRecord | null> {
  const row = await db
    .prepare(`SELECT ${COLUMNS} FROM operations WHERE user_id = ? AND idempotency_key = ?`)
    .bind(userId, idempotencyKey)
    .first<OperationRow>();
  return row ? toRecord(row) : null;
}

/**
 * Claims the next due operation. An operation whose lease expired while applying
 * is reclaimed with outcome_unknown set: the previous worker may have reached the
 * provider, so the next attempt must reconcile before writing. One operation per
 * user runs at a time, which keeps a user's changes ordered.
 */
export async function claimNextOperation(
  db: D1Database,
  leaseToken: string,
  now: number,
  leaseMs: number,
  userId: string | null,
): Promise<ClaimedOperation | null> {
  const row = await db
    .prepare(
      `UPDATE operations
       SET outcome_unknown = CASE WHEN status = 'applying' THEN 1 ELSE outcome_unknown END,
           status = 'applying', attempts = attempts + 1, lease_token = ?1,
           lease_expires_at = ?2, updated_at = ?3
       WHERE id = (
         SELECT o.id FROM operations o
         WHERE (?4 IS NULL OR o.user_id = ?4)
           AND ((o.status IN ('ready', 'retry_wait') AND o.next_attempt_at <= ?3)
             OR (o.status = 'applying' AND o.lease_expires_at <= ?3))
           AND NOT EXISTS (
             SELECT 1 FROM operations a
             WHERE a.user_id = o.user_id AND a.status = 'applying' AND a.lease_expires_at > ?3)
         ORDER BY o.next_attempt_at, o.rowid LIMIT 1)
       RETURNING ${COLUMNS}`,
    )
    .bind(leaseToken, now + leaseMs, now, userId)
    .first<OperationRow>();
  return row ? { ...toRecord(row), leaseToken } : null;
}

export function operationLeaseGuard(claim: ClaimedOperation): Guard {
  return {
    sql: "EXISTS (SELECT 1 FROM operations WHERE id = ? AND lease_token = ?)",
    params: [claim.id, claim.leaseToken],
  };
}

export interface AttemptResult {
  status: Exclude<OperationStatus, "applying" | "ready">;
  nextAttemptAt?: number | null;
  outcomeUnknown?: boolean;
  result?: unknown;
  errorClass?: string | null;
  /** Replaces the confirmed preview when returning to awaiting_confirmation. */
  confirmation?: { preview: unknown; previewHash: string; expiresAt: number; intent: unknown };
}

/** Ends a claimed attempt. Must be the last statement in its batch (see Guard). */
export function finishAttemptStatement(
  db: D1Database,
  claim: ClaimedOperation,
  attempt: AttemptResult,
  now: number,
): D1PreparedStatement {
  const c = attempt.confirmation;
  return db
    .prepare(
      `UPDATE operations SET status = ?, next_attempt_at = ?, outcome_unknown = ?,
         result = COALESCE(?, result), error_class = ?,
         intent = COALESCE(?, intent), preview = COALESCE(?, preview),
         preview_hash = COALESCE(?, preview_hash),
         confirmation_expires_at = COALESCE(?, confirmation_expires_at),
         lease_token = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE id = ? AND lease_token = ?`,
    )
    .bind(
      attempt.status,
      attempt.nextAttemptAt ?? null,
      (attempt.outcomeUnknown ?? claim.outcomeUnknown) ? 1 : 0,
      attempt.result === undefined ? null : JSON.stringify(attempt.result),
      attempt.errorClass ?? null,
      c ? JSON.stringify(c.intent) : null,
      c ? JSON.stringify(c.preview) : null,
      c?.previewHash ?? null,
      c?.expiresAt ?? null,
      now,
      claim.id,
      claim.leaseToken,
    );
}

/** Cancels confirmations nobody acted on in time, in a bounded batch. */
export function expireConfirmationsStatement(
  db: D1Database,
  now: number,
  limit: number,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE operations SET status = 'cancelled', error_class = 'confirmation_expired',
         updated_at = ?1
       WHERE id IN (
         SELECT id FROM operations
         WHERE status = 'awaiting_confirmation' AND confirmation_expires_at <= ?1 LIMIT ?2)`,
    )
    .bind(now, limit);
}

/**
 * Removes finished operations (and their button tokens) past the retention
 * period, in bounded batches. Unfinished operations are never purged.
 */
export function purgeFinishedOperationsStatements(
  db: D1Database,
  olderThan: number,
  limit: number,
): D1PreparedStatement[] {
  const finished = `SELECT id FROM operations
    WHERE status IN ('succeeded', 'failed', 'cancelled') AND updated_at < ?1
    ORDER BY id LIMIT ?2`;
  return [
    db
      .prepare(`DELETE FROM callback_refs WHERE operation_id IN (${finished})`)
      .bind(olderThan, limit),
    db.prepare(`DELETE FROM operations WHERE id IN (${finished})`).bind(olderThan, limit),
  ];
}
