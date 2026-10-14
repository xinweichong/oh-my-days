import { ActionButtons } from "../application/reactions";
import { localDateAt, offsetMinutesAt } from "../domain/time";
import type { Clock } from "../shared/clock";
import type { IdGenerator } from "../shared/ids";
import { logEvent } from "../shared/log";
import type { Guard } from "../storage/guard";
import { enqueueStatement } from "../storage/outbox";
import { findUserById } from "../storage/users";
import { formatDayLabel, formatTime } from "../telegram/format";

/**
 * While the Google OAuth app is in Testing, access ends a fixed number of days
 * after each consent. One warning goes out about a day before, per connection
 * generation; reconnecting starts a new generation and a new estimate. The
 * after-the-fact reauthorization alert is unchanged.
 */

const DAY_MS = 24 * 60 * 60_000;
/** How far ahead of the estimated end the warning goes out. */
export const EXPIRY_WARNING_LEAD_MS = DAY_MS;
const BATCH = 20;

export interface AccessExpiryDeps {
  db: D1Database;
  clock: Clock;
  ids: IdGenerator;
  /** Null once the app is verified: no warnings. */
  ttlDays: number | null;
}

/** The estimated end of Google access for a connection made at `connectedAt`. */
export function accessEndsAt(connectedAt: number, ttlDays: number): number {
  return connectedAt + ttlDays * DAY_MS;
}

interface Row {
  user_id: string;
  auth_generation: number;
  connected_at: number;
}

export async function warnBeforeAccessEnds(deps: AccessExpiryDeps): Promise<number> {
  if (deps.ttlDays === null) return 0;
  const now = deps.clock.now();
  const ttlMs = deps.ttlDays * DAY_MS;
  // Connections inside the warning window that haven't been warned this generation.
  const { results } = await deps.db
    .prepare(
      `SELECT user_id, auth_generation, connected_at FROM google_connections
       WHERE status = 'active' AND connected_at <= ? AND connected_at > ?
         AND (expiry_warned_generation IS NULL OR expiry_warned_generation <> auth_generation)
       LIMIT ?`,
    )
    .bind(now - (ttlMs - EXPIRY_WARNING_LEAD_MS), now - ttlMs, BATCH)
    .all<Row>();

  let sent = 0;
  for (const row of results) {
    const user = await findUserById(deps.db, row.user_id);
    if (!user) continue;
    const endsAt = accessEndsAt(row.connected_at, deps.ttlDays);
    const buttons = new ActionButtons(deps.ids, user.id, now);
    // Only while this generation is still connected and unwarned.
    const guard: Guard = {
      sql: `EXISTS (SELECT 1 FROM google_connections WHERE user_id = ? AND auth_generation = ?
              AND status = 'active')`,
      params: [user.id, row.auth_generation],
    };
    const results = await deps.db.batch([
      deps.db
        .prepare(
          `UPDATE google_connections SET expiry_warned_generation = auth_generation
           WHERE user_id = ? AND auth_generation = ? AND status = 'active'
             AND (expiry_warned_generation IS NULL OR expiry_warned_generation <> auth_generation)`,
        )
        .bind(user.id, row.auth_generation),
      enqueueStatement(
        deps.db,
        deps.ids,
        user.id,
        {
          logicalKey: `access_expiry:${row.auth_generation}:${row.connected_at}`,
          call: {
            method: "sendMessage",
            params: {
              chat_id: user.privateChatId,
              text: `Google access ends ${whenText(endsAt, now, user.timezone)}. Reconnect now to avoid a gap.`,
              reply_markup: {
                inline_keyboard: [[buttons.button("Reconnect", "reconnect", {})]],
              },
            },
          },
        },
        now,
        guard,
      ),
      ...buttons.statements(deps.db, guard),
    ]);
    if (results[0]?.meta.changes === 1) {
      sent++;
      logEvent("google.access_expiry_warned", { userId: user.id });
    }
  }
  return sent;
}

/** "tomorrow around 9am", "today around 9am", or "Fri 2 Oct around 9am". */
export function whenText(endsAt: number, now: number, timeZone: string): string {
  const day = localDateAt(endsAt, timeZone);
  const today = localDateAt(now, timeZone);
  const tomorrow = localDateAt(now + DAY_MS, timeZone);
  const label = day === today ? "today" : day === tomorrow ? "tomorrow" : formatDayLabel(day);
  return `${label} around ${formatTime(nearestLocalHour(endsAt, timeZone), timeZone)}`;
}

/** Rounds to the nearest hour on the local clock (zones can be offset by 30 or 45 minutes). */
function nearestLocalHour(instant: number, timeZone: string): number {
  const shift = offsetMinutesAt(instant, timeZone) * 60_000;
  return Math.round((instant + shift) / 3_600_000) * 3_600_000 - shift;
}
