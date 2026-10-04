import { ActionButtons } from "../application/reactions";
import type { Clock } from "../shared/clock";
import type { IdGenerator } from "../shared/ids";
import { logEvent } from "../shared/log";
import type { Guard } from "../storage/guard";
import { enqueueStatement } from "../storage/outbox";
import { findUserById } from "../storage/users";

/** Spec §8: alert after three consecutive failed checks. */
export const FAILED_CHECKS_BEFORE_ALERT = 3;

export interface SyncHealthDeps {
  db: D1Database;
  clock: Clock;
  ids: IdGenerator;
}

interface HealthRow {
  id: string;
  sync_alerted_at: number | null;
  max_failures: number;
  oldest_success: number | null;
  error_class: string | null;
}

/**
 * Sends one outage alert when any calendar reaches three consecutive failed
 * checks (a check counts once, whatever its internal retries), and one recovery
 * notice once every calendar has synced successfully since the alert. Lost
 * authorization is alerted separately and immediately.
 */
export async function evaluateSyncHealth(deps: SyncHealthDeps): Promise<number> {
  const { results } = await deps.db
    .prepare(
      `SELECT u.id, u.sync_alerted_at,
         MAX(s.consecutive_failures) AS max_failures,
         MIN(COALESCE(s.last_success_at, 0)) AS oldest_success,
         (SELECT last_error_class FROM calendar_sync x WHERE x.user_id = u.id
            ORDER BY consecutive_failures DESC LIMIT 1) AS error_class
       FROM users u
       JOIN google_connections g ON g.user_id = u.id AND g.status = 'active'
       JOIN calendar_sync s ON s.user_id = u.id
       GROUP BY u.id`,
    )
    .all<HealthRow>();
  let sent = 0;
  for (const row of results) {
    const now = deps.clock.now();
    if (row.sync_alerted_at === null && row.max_failures >= FAILED_CHECKS_BEFORE_ALERT) {
      sent += await notify(deps, row.id, now, "outage", row.error_class);
    } else if (
      row.sync_alerted_at !== null &&
      row.max_failures === 0 &&
      (row.oldest_success ?? 0) > row.sync_alerted_at
    ) {
      sent += await notify(deps, row.id, now, "recovered", null, row.sync_alerted_at);
    }
  }
  return sent;
}

function describe(errorClass: string | null): string {
  switch (errorClass) {
    case "retryable":
      return "Google Calendar was unavailable";
    case "forbidden":
    case "not_found":
      return "a calendar is no longer accessible";
    default:
      return "Google Calendar returned an unexpected response";
  }
}

async function notify(
  deps: SyncHealthDeps,
  userId: string,
  now: number,
  kind: "outage" | "recovered",
  errorClass: string | null,
  alertedAt: number | null = null,
): Promise<number> {
  const user = await findUserById(deps.db, userId);
  if (!user) return 0;
  // The state change is the claim; the message is sent only if this run made it.
  const claim =
    kind === "outage"
      ? deps.db
          .prepare("UPDATE users SET sync_alerted_at = ? WHERE id = ? AND sync_alerted_at IS NULL")
          .bind(now, userId)
      : deps.db
          .prepare("UPDATE users SET sync_alerted_at = NULL WHERE id = ? AND sync_alerted_at = ?")
          .bind(userId, alertedAt);
  const guard: Guard =
    kind === "outage"
      ? {
          sql: "EXISTS (SELECT 1 FROM users WHERE id = ? AND sync_alerted_at = ?)",
          params: [userId, now],
        }
      : {
          sql: "EXISTS (SELECT 1 FROM users WHERE id = ? AND sync_alerted_at IS NULL)",
          params: [userId],
        };
  const buttons = new ActionButtons(deps.ids, userId, now);
  const text =
    kind === "outage"
      ? `Google Calendar sync has failed ${FAILED_CHECKS_BEFORE_ALERT} times in a row (${describe(errorClass)}). I'll keep trying; recent changes in Calendar may not show here yet.`
      : "Google Calendar sync is working again.";
  const keyboard =
    kind === "outage"
      ? { inline_keyboard: [[buttons.button("Force poll", "force_poll", {})]] }
      : undefined;
  const results = await deps.db.batch([
    claim,
    ...buttons.statements(deps.db, guard),
    enqueueStatement(
      deps.db,
      deps.ids,
      userId,
      {
        logicalKey: `sync-${kind}:${alertedAt ?? now}`,
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
  ]);
  const won = results[0]?.meta.changes === 1;
  if (won) logEvent(`sync.${kind}_notified`, { userId });
  return won ? 1 : 0;
}
