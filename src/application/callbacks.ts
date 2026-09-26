import type { Clock } from "../shared/clock";
import type { IdGenerator } from "../shared/ids";
import { logEvent } from "../shared/log";
import {
  type CallbackRef,
  consumeCallbackRefStatements,
  findCallbackRef,
} from "../storage/callback-refs";
import { allOf, type Guard } from "../storage/guard";
import { findOperation, type OperationRecord } from "../storage/operations";
import type { UserRecord } from "../storage/users";
import type { TelegramCall } from "../telegram/api";
import { BUTTON_EXPIRED } from "../telegram/messages";
import type { CallbackHandler, HandlerResult } from "../telegram/router";
import type { InboundCallback } from "../telegram/update";
import type { HandlerRegistry } from "./operation-types";
import { parseCallbackData, prepareProposal } from "./proposals";

export const CALLBACK_TEXT = {
  confirmed: "Confirmed.",
  cancelled: "Cancelled. Nothing was changed.",
  undoRequested: "Undoing.",
  undoUnavailable: "Undo isn't available for this change.",
  outdated: "This confirmation is out of date.",
} as const;

export interface CallbackDeps {
  db: D1Database;
  clock: Clock;
  ids: IdGenerator;
  handlers: HandlerRegistry;
}

/**
 * Handles Confirm, Cancel, and Undo buttons. Button data is an opaque token that
 * must belong to the pressing user, be unused and unexpired, and (for Confirm)
 * match the exact preview the operation still carries. Each press is consumed
 * atomically with its effect, so repeated or concurrent presses act once.
 */
export function createCallbackHandler(deps: CallbackDeps): CallbackHandler {
  return async (user, callback) => {
    const token = parseCallbackData(callback.data);
    const ref = token ? await findCallbackRef(deps.db, user.id, token) : null;
    if (!ref) return answer(callback, BUTTON_EXPIRED);

    // A retry of this same press after a crash: report the effect it already had.
    const usedBy = `cb:${callback.callbackQueryId}`;
    if (ref.usedBy === usedBy) return settled(user, callback, ref.action);
    if (ref.usedAt !== null || ref.expiresAt <= deps.clock.now()) {
      return answer(callback, BUTTON_EXPIRED);
    }

    const op = await findOperation(deps.db, user.id, ref.operationId);
    if (!op) return answer(callback, BUTTON_EXPIRED);

    switch (ref.action) {
      case "confirm":
        return confirm(deps, user, callback, ref, op, usedBy);
      case "cancel":
        return cancel(deps, user, callback, ref, op, usedBy);
      case "undo":
        return undo(deps, user, callback, ref, op, usedBy);
    }
  };
}

async function confirm(
  deps: CallbackDeps,
  user: UserRecord,
  callback: InboundCallback,
  ref: CallbackRef,
  op: OperationRecord,
  usedBy: string,
): Promise<HandlerResult> {
  const now = deps.clock.now();
  if (
    op.status !== "awaiting_confirmation" ||
    op.previewHash !== ref.previewHash ||
    (op.confirmationExpiresAt ?? 0) <= now
  ) {
    return answer(callback, CALLBACK_TEXT.outdated);
  }
  const confirmed = await consumeWith(deps, ref, usedBy, (guard) => [
    deps.db
      .prepare(
        `UPDATE operations SET status = 'ready', next_attempt_at = ?1, updated_at = ?1
         WHERE id = ?2 AND user_id = ?3 AND status = 'awaiting_confirmation'
           AND preview_hash = ?4 AND confirmation_expires_at > ?1 AND ${guard.sql}`,
      )
      .bind(now, op.id, user.id, ref.previewHash, ...guard.params),
  ]);
  return confirmed ? settled(user, callback, "confirm") : answer(callback, CALLBACK_TEXT.outdated);
}

async function cancel(
  deps: CallbackDeps,
  user: UserRecord,
  callback: InboundCallback,
  ref: CallbackRef,
  op: OperationRecord,
  usedBy: string,
): Promise<HandlerResult> {
  if (op.status !== "awaiting_confirmation" && op.status !== "needs_resolution") {
    return answer(callback, BUTTON_EXPIRED);
  }
  const now = deps.clock.now();
  const won = await consumeWith(deps, ref, usedBy, (guard) => [
    deps.db
      .prepare(
        `UPDATE operations SET status = 'cancelled', error_class = 'user_cancelled', updated_at = ?
         WHERE id = ? AND user_id = ? AND status IN ('awaiting_confirmation', 'needs_resolution')
           AND ${guard.sql}`,
      )
      .bind(now, op.id, user.id, ...guard.params),
  ]);
  return won ? settled(user, callback, "cancel") : answer(callback, BUTTON_EXPIRED);
}

async function undo(
  deps: CallbackDeps,
  user: UserRecord,
  callback: InboundCallback,
  ref: CallbackRef,
  op: OperationRecord,
  usedBy: string,
): Promise<HandlerResult> {
  const inverse = op.status === "succeeded" ? deps.handlers.get(op.kind)?.inverse?.(op) : null;
  if (!inverse) return answer(callback, CALLBACK_TEXT.undoUnavailable);

  // Undo is a new operation through the same pipeline; its validity (nothing
  // changed since) is checked against provider state when it runs.
  const prepared = await prepareProposal(deps, user, {
    ...inverse,
    idempotencyKey: `undo:${op.id}`,
  });
  const won = await consumeWith(deps, ref, usedBy, (guard) => prepared.statements(deps.db, guard));
  if (!won) return answer(callback, CALLBACK_TEXT.undoUnavailable);
  const result = settled(user, callback, "undo");
  return { replies: [...result.replies, ...prepared.replies] };
}

/**
 * Consumes the token and applies `effects` in one batch, with every effect
 * guarded on this consumption. Returns true only if this press won and its
 * final effect took place (a lost race changes nothing).
 */
async function consumeWith(
  deps: CallbackDeps,
  ref: CallbackRef,
  usedBy: string,
  effects: (guard: Guard) => D1PreparedStatement[],
): Promise<boolean> {
  const consumed = consumeCallbackRefStatements(deps.db, ref, usedBy, deps.clock.now());
  const effectStatements = effects(allOf(consumed.guard));
  const results = await deps.db.batch([...consumed.statements, ...effectStatements]);
  const won = results[0]?.meta.changes === 1 && results.at(-1)?.meta.changes === 1;
  if (!won) logEvent("callback.lost_race", { operationId: ref.operationId, action: ref.action });
  return won;
}

function settled(
  user: UserRecord,
  callback: InboundCallback,
  action: CallbackRef["action"],
): HandlerResult {
  const text =
    action === "confirm"
      ? CALLBACK_TEXT.confirmed
      : action === "cancel"
        ? CALLBACK_TEXT.cancelled
        : CALLBACK_TEXT.undoRequested;
  const replies: TelegramCall[] = [
    {
      method: "answerCallbackQuery",
      params: { callback_query_id: callback.callbackQueryId, text },
    },
  ];
  // Remove the buttons so the message no longer invites a second press.
  if (callback.messageId !== null) {
    replies.push({
      method: "editMessageReplyMarkup",
      params: { chat_id: user.privateChatId, message_id: callback.messageId },
    });
  }
  if (action === "cancel") {
    replies.push({ method: "sendMessage", params: { chat_id: user.privateChatId, text } });
  }
  return { replies };
}

function answer(callback: InboundCallback, text: string): HandlerResult {
  return {
    replies: [
      {
        method: "answerCallbackQuery",
        params: { callback_query_id: callback.callbackQueryId, text },
      },
    ],
  };
}
