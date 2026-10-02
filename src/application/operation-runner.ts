import type { CalendarDirectoryFactory, CalendarPortFactory } from "../calendar/port";
import { type BackoffPolicy, retryDelayMs } from "../domain/retry";
import type { Clock } from "../shared/clock";
import type { IdGenerator } from "../shared/ids";
import { logEvent } from "../shared/log";
import { insertCallbackRefStatement } from "../storage/callback-refs";
import {
  type AttemptResult,
  type ClaimedOperation,
  claimNextOperation,
  finishAttemptStatement,
  operationLeaseGuard,
} from "../storage/operations";
import { enqueueStatement } from "../storage/outbox";
import { findUserById, type UserRecord } from "../storage/users";
import type { InlineKeyboardMarkup } from "../telegram/api";
import type {
  ExecutionOutcome,
  HandlerRegistry,
  NoticeEvent,
  OperationHandler,
} from "./operation-types";
import { CONFIRMATION_TTL_MS, callbackData, confirmationKeyboard, previewHash } from "./proposals";

/** Longer than any single provider call, including its timeout. */
export const OPERATION_LEASE_MS = 60_000;
/** Attempts before an operation stops retrying and asks for attention. */
export const OPERATION_MAX_ATTEMPTS = 8;
/** How long an Undo button remains usable; validity is rechecked when pressed. */
export const UNDO_TTL_MS = 24 * 60 * 60_000;
const BACKOFF: BackoffPolicy = { baseMs: 30_000, maxMs: 30 * 60_000 };

export interface RunnerDeps {
  db: D1Database;
  clock: Clock;
  ids: IdGenerator;
  random: () => number;
  handlers: HandlerRegistry;
  calendarFor: CalendarPortFactory;
  /** Calendar-list access; absent where no handler needs it. */
  directoryFor?: CalendarDirectoryFactory;
}

/**
 * Runs up to `limit` due operations, optionally for one user. Each attempt's
 * outcome, notices, and follow-up tokens commit atomically under the lease, so
 * an attempt that lost its lease changes nothing.
 */
export async function runDueOperations(
  deps: RunnerDeps,
  limit: number,
  userId: string | null = null,
): Promise<number> {
  let attempted = 0;
  while (attempted < limit) {
    const op = await claimNextOperation(
      deps.db,
      deps.ids.next(),
      deps.clock.now(),
      OPERATION_LEASE_MS,
      userId,
    );
    if (!op) break;
    attempted++;
    const user = await findUserById(deps.db, op.userId);
    const handler = deps.handlers.get(op.kind);
    if (!user || !handler) {
      await deps.db.batch([
        finishAttemptStatement(
          deps.db,
          op,
          { status: "failed", errorClass: "unknown_kind" },
          deps.clock.now(),
        ),
      ]);
      continue;
    }

    let outcome: ExecutionOutcome;
    try {
      outcome = await handler.execute({
        op,
        user,
        calendar: await deps.calendarFor(user.id),
        directory: (await deps.directoryFor?.(user.id)) ?? null,
        now: deps.clock.now(),
      });
    } catch (error) {
      // An exception may follow a provider write, so the outcome is unknown.
      logEvent("operation.handler_error", {
        operationId: op.id,
        errorClass: error instanceof Error ? error.name : "unknown",
      });
      outcome = { kind: "retry", errorClass: "handler_error", outcomeUnknown: true };
    }
    await commitAttempt(deps, handler, user, op, outcome);
  }
  return attempted;
}

async function commitAttempt(
  deps: RunnerDeps,
  handler: OperationHandler,
  user: UserRecord,
  op: ClaimedOperation,
  outcome: ExecutionOutcome,
): Promise<void> {
  const now = deps.clock.now();
  const guard = operationLeaseGuard(op);
  const statements: D1PreparedStatement[] = [];
  const notify = (key: string, event: NoticeEvent, keyboard?: InlineKeyboardMarkup) => {
    const text = handler.notice(op, event, user);
    if (text === null) return;
    statements.push(
      enqueueStatement(
        deps.db,
        deps.ids,
        user.id,
        {
          logicalKey: `op:${op.id}:${key}`,
          call: {
            method: "sendMessage",
            params: {
              chat_id: user.privateChatId,
              text,
              ...(keyboard ? { reply_markup: keyboard } : {}),
            },
          },
        },
        now,
        guard,
      ),
    );
  };
  const token = (action: "confirm" | "cancel" | "undo", hash: string | null, expiresAt: number) => {
    const value = deps.ids.next();
    statements.push(
      insertCallbackRefStatement(
        deps.db,
        { token: value, userId: user.id, operationId: op.id, action, previewHash: hash, expiresAt },
        now,
        guard,
      ),
    );
    return value;
  };

  let attempt: AttemptResult;
  switch (outcome.kind) {
    case "succeeded": {
      attempt = { status: "succeeded", result: outcome.result, outcomeUnknown: false };
      const settled = { ...op, status: "succeeded" as const, result: outcome.result };
      const undo = handler.inverse?.(settled, user) ?? null;
      const keyboard = undo
        ? {
            inline_keyboard: [
              [
                {
                  text: "Undo",
                  callback_data: callbackData(token("undo", null, now + UNDO_TTL_MS)),
                },
              ],
            ],
          }
        : undefined;
      notify("result", outcome, keyboard);
      const follow = await handler.onSucceeded?.({
        op: settled,
        user,
        result: outcome.result,
        now,
        ids: deps.ids,
        db: deps.db,
      });
      if (follow) {
        statements.push(...(follow.statements?.(deps.db, guard) ?? []));
        follow.replies.forEach((call, i) => {
          statements.push(
            enqueueStatement(
              deps.db,
              deps.ids,
              user.id,
              { logicalKey: `op:${op.id}:after:${i}`, call },
              now,
              guard,
            ),
          );
        });
      }
      break;
    }
    case "retry": {
      const outcomeUnknown = outcome.outcomeUnknown ?? op.outcomeUnknown;
      if (op.attempts >= OPERATION_MAX_ATTEMPTS) {
        attempt = { status: "needs_resolution", errorClass: "retries_exhausted", outcomeUnknown };
        notify(`resolution:${op.attempts}`, {
          kind: "needs_resolution",
          reason: "retries_exhausted",
        });
        break;
      }
      const delay = retryDelayMs(op.attempts, BACKOFF, deps.random, outcome.retryAfterMs ?? null);
      attempt = {
        status: "retry_wait",
        nextAttemptAt: now + delay,
        errorClass: outcome.errorClass,
        outcomeUnknown,
      };
      // One pending notice per operation; retries after it stay quiet.
      notify("pending", { kind: "pending", outcomeUnknown });
      break;
    }
    case "needs_reconfirmation": {
      const hash = await previewHash(op.kind, outcome.intent, outcome.preview);
      const expiresAt = now + CONFIRMATION_TTL_MS;
      attempt = {
        status: "awaiting_confirmation",
        outcomeUnknown: false,
        confirmation: {
          intent: outcome.intent,
          preview: outcome.preview,
          previewHash: hash,
          expiresAt,
        },
      };
      const keyboard = confirmationKeyboard(
        token("confirm", hash, expiresAt),
        token("cancel", hash, expiresAt),
        outcome.preview.confirmLabel,
      );
      notify(`reconfirm:${op.attempts}`, outcome, keyboard);
      break;
    }
    case "needs_resolution":
      attempt = {
        status: "needs_resolution",
        errorClass: outcome.reason,
        result: outcome.details ?? null,
      };
      notify(`resolution:${op.attempts}`, outcome);
      break;
    case "auth_required":
      attempt = { status: "auth_required", errorClass: "auth_required" };
      notify(`auth:${op.attempts}`, outcome);
      break;
    case "failed":
      attempt = { status: "failed", errorClass: outcome.errorClass };
      notify(`failed:${op.attempts}`, outcome);
      break;
  }

  statements.push(finishAttemptStatement(deps.db, op, attempt, now));
  const results = await deps.db.batch(statements);
  if (results.at(-1)?.meta.changes !== 1) {
    logEvent("operation.lease_lost", { operationId: op.id });
    return;
  }
  logEvent("operation.attempt", {
    operationId: op.id,
    kind: op.kind,
    attempt: op.attempts,
    status: attempt.status,
    errorClass: attempt.errorClass ?? null,
  });
}
