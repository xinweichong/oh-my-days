import type { Clock } from "../shared/clock";
import type { IdGenerator } from "../shared/ids";
import { logEvent } from "../shared/log";
import {
  type ClaimedUpdate,
  claimNextUpdate,
  finishUpdateStatement,
  inboxLeaseGuard,
} from "../storage/inbox";
import { enqueueStatement } from "../storage/outbox";
import { findUserById, type UserRecord } from "../storage/users";
import type { TelegramCall } from "../telegram/api";
import { PROCESSING_FAILED } from "../telegram/messages";
import type { HandlerResult, UpdateHandler } from "../telegram/router";

export const INBOX_LEASE_MS = 30_000;
/** Attempts before an update is abandoned and the user is told to resend. */
export const INBOX_MAX_ATTEMPTS = 3;

export interface InboxDeps {
  db: D1Database;
  clock: Clock;
  ids: IdGenerator;
  handler: UpdateHandler;
}

/** Processes up to `limit` of one user's updates in order. Returns the number finished. */
export async function processUserInbox(
  deps: InboxDeps,
  userId: string,
  limit: number,
): Promise<number> {
  let finished = 0;
  while (finished < limit) {
    const claim = await claimNextUpdate(
      deps.db,
      userId,
      deps.ids.next(),
      deps.clock.now(),
      INBOX_LEASE_MS,
    );
    if (!claim) break;
    const user = await findUserById(deps.db, claim.userId);
    if (!user) break;

    if (claim.attempts > INBOX_MAX_ATTEMPTS) {
      await commit(deps, user, claim, "failed", { replies: [failureReply(user, claim)] });
      logEvent("inbox.abandoned", { updateId: claim.updateId, attempts: claim.attempts });
      finished++;
      continue;
    }

    let result: HandlerResult;
    try {
      result = await deps.handler(user, claim.update);
    } catch (error) {
      // Leave the claim to expire; the scheduler retries it after the lease.
      logEvent("inbox.handler_error", {
        updateId: claim.updateId,
        errorClass: error instanceof Error ? error.name : "unknown",
      });
      break;
    }
    if (!(await commit(deps, user, claim, "processed", result))) break;
    finished++;
  }
  return finished;
}

async function commit(
  deps: InboxDeps,
  user: UserRecord,
  claim: ClaimedUpdate,
  status: "processed" | "failed",
  result: HandlerResult,
): Promise<boolean> {
  const now = deps.clock.now();
  const guard = inboxLeaseGuard(claim);
  const statements = [
    ...(result.statements?.(deps.db, guard) ?? []),
    ...result.replies.map((call, index) =>
      enqueueStatement(
        deps.db,
        deps.ids,
        user.id,
        { logicalKey: `inbox:${claim.updateId}:${index}`, call },
        now,
        guard,
      ),
    ),
    finishUpdateStatement(deps.db, claim, status, now),
  ];
  const results = await deps.db.batch(statements);
  const committed = results.at(-1)?.meta.changes === 1;
  if (!committed) logEvent("inbox.lease_lost", { updateId: claim.updateId });
  return committed;
}

function failureReply(user: UserRecord, claim: ClaimedUpdate): TelegramCall {
  if (claim.update.kind === "callback_query") {
    return {
      method: "answerCallbackQuery",
      params: { callback_query_id: claim.update.callbackQueryId, text: PROCESSING_FAILED },
    };
  }
  return {
    method: "sendMessage",
    params: { chat_id: user.privateChatId, text: PROCESSING_FAILED },
  };
}
