import type { CalendarDirectory, CalendarListEntry, CalendarPort } from "../calendar/port";
import type { AppConfig } from "../env";
import type { AccessTokenSource } from "../google/calendar-api";
import {
  type GoogleOAuth,
  pkceChallenge,
  REQUIRED_CALENDAR_SCOPES,
  randomUrlToken,
} from "../google/oauth";
import type { TokenCipher } from "../security/token-cipher";
import type { Clock } from "../shared/clock";
import type { IdGenerator } from "../shared/ids";
import { logEvent } from "../shared/log";
import {
  connectionGuard,
  consumeLink,
  consumeOAuthState,
  findConnection,
  findStateOutcome,
  findUsableLink,
  insertConnectLinkStatement,
  insertOAuthStateStatement,
  type LinkPurpose,
  markAuthRequiredStatement,
  recordStateOutcomeStatement,
  replaceCalendarListStatements,
  saveAccessTokenStatement,
  saveConnectionStatement,
} from "../storage/google";
import { type Guard, unguarded } from "../storage/guard";
import { enqueueStatement } from "../storage/outbox";
import { advanceSetupStatement, findUserById, type UserRecord } from "../storage/users";
import type { TelegramCall } from "../telegram/api";
import { ActionButtons, type Reaction } from "./reactions";

/** Connection links and OAuth state expire quickly (backend plan §7). */
export const CONNECT_LINK_TTL_MS = 10 * 60_000;
export const OAUTH_STATE_TTL_MS = 10 * 60_000;
/** Refresh access tokens this long before Google's stated expiry. */
const ACCESS_TOKEN_MARGIN_MS = 60_000;

export interface ConnectionDeps {
  db: D1Database;
  clock: Clock;
  ids: IdGenerator;
  config: AppConfig;
  oauth: GoogleOAuth;
  cipher: () => Promise<TokenCipher>;
  /** Builds the Calendar adapter for a token source; injected for tests. */
  calendarApi: (tokens: AccessTokenSource) => CalendarPort & CalendarDirectory;
}

export function redirectUri(config: AppConfig): string {
  return `${config.publicBaseUrl}/oauth/callback`;
}

export function telegramContinueUrl(config: AppConfig): string {
  return `https://t.me/${config.telegramBotUsername}?start=setup`;
}

/** A fresh, short-lived, user-bound link to the connection page. */
export function connectLink(
  deps: Pick<ConnectionDeps, "clock" | "ids" | "config">,
  userId: string,
  purpose: LinkPurpose,
): Reaction & { url: string } {
  const token = deps.ids.next();
  const now = deps.clock.now();
  return {
    url: `${deps.config.publicBaseUrl}/connect?t=${encodeURIComponent(token)}`,
    replies: [],
    statements: (db, guard) => [
      insertConnectLinkStatement(db, token, userId, purpose, now + CONNECT_LINK_TTL_MS, now, guard),
    ],
  };
}

/** A message with a button that opens a fresh connection link. */
export function connectMessage(
  deps: Pick<ConnectionDeps, "clock" | "ids" | "config">,
  user: UserRecord,
  purpose: LinkPurpose,
  text: string,
): Reaction {
  const link = connectLink(deps, user.id, purpose);
  const label = purpose === "connect" ? "Connect Google Calendar" : "Reconnect Google Calendar";
  return {
    replies: [
      {
        method: "sendMessage",
        params: {
          chat_id: user.privateChatId,
          text,
          reply_markup: { inline_keyboard: [[{ text: label, url: link.url }]] },
        },
      },
    ],
    ...(link.statements ? { statements: link.statements } : {}),
  };
}

// --- Browser flow -------------------------------------------------------------

/** Checks a landing link without consuming it (previews and refreshes are harmless). */
export async function inspectLink(
  deps: ConnectionDeps,
  token: string | null,
): Promise<LinkPurpose | null> {
  if (!token) return null;
  return (await findUsableLink(deps.db, token, deps.clock.now()))?.purpose ?? null;
}

/** Consumes the link and returns Google's authorization URL, or null if the link is unusable. */
export async function beginAuthorization(
  deps: ConnectionDeps,
  token: string | null,
): Promise<string | null> {
  if (!token) return null;
  const now = deps.clock.now();
  const link = await consumeLink(deps.db, token, now);
  if (!link) return null;
  const state = randomUrlToken();
  const verifier = randomUrlToken();
  await insertOAuthStateStatement(
    deps.db,
    state,
    link.userId,
    link.purpose,
    verifier,
    now + OAUTH_STATE_TTL_MS,
    now,
  ).run();
  const existing = await findConnection(deps.db, link.userId);
  const hint = link.purpose === "reconnect" ? existing?.email : undefined;
  return deps.oauth.authorizationUrl(state, await pkceChallenge(verifier), hint);
}

export type AuthorizationOutcome =
  | "connected"
  | "reconnected"
  | "declined"
  | "invalid_link"
  | "provider_failure"
  | "account_mismatch"
  | "missing_scopes";

const OUTCOMES: readonly AuthorizationOutcome[] = [
  "connected",
  "reconnected",
  "declined",
  "invalid_link",
  "provider_failure",
  "account_mismatch",
  "missing_scopes",
];

export interface CallbackParams {
  state: string | null;
  code: string | null;
  error: string | null;
}

/**
 * Completes Google's redirect. The user is identified only by the single-use
 * state created from their Telegram-issued link; nothing the browser supplies
 * names a user. The outcome is persisted before it is shown, and a refreshed
 * callback shows the recorded outcome without exchanging the code again.
 */
export async function completeAuthorization(
  deps: ConnectionDeps,
  params: CallbackParams,
  setupPrompt: (user: UserRecord) => Promise<Reaction>,
): Promise<AuthorizationOutcome> {
  if (!params.state) return "invalid_link";
  const now = deps.clock.now();
  const consumed = await consumeOAuthState(deps.db, params.state, now);
  if (!consumed) return priorOutcome(deps, params.state);
  const user = await findUserById(deps.db, consumed.userId);
  if (!user) return "invalid_link";
  const state = params.state;

  const finish = async (outcome: AuthorizationOutcome, reaction: Reaction = { replies: [] }) => {
    await deps.db.batch([
      ...(reaction.statements?.(deps.db, unguarded) ?? []),
      ...reaction.replies.map((call, i) =>
        enqueueStatement(
          deps.db,
          deps.ids,
          user.id,
          { logicalKey: `oauth:${state}:${i}`, call },
          now,
          unguarded,
        ),
      ),
      recordStateOutcomeStatement(deps.db, state, outcome),
    ]);
    logEvent("oauth.outcome", { outcome });
    return outcome;
  };

  if (params.error || !params.code) {
    return finish(params.error === "access_denied" ? "declined" : "provider_failure");
  }
  const exchanged = await deps.oauth.exchangeCode(params.code, consumed.codeVerifier);
  if (!exchanged.ok) return finish("provider_failure");
  if (!REQUIRED_CALENDAR_SCOPES.every((s) => exchanged.grantedScopes.includes(s))) {
    return finish("missing_scopes");
  }

  const existing = await findConnection(deps.db, user.id);
  const replacing = existing !== null && existing.googleSubject !== exchanged.identity.subject;
  if (replacing && consumed.purpose !== "replace") {
    return finish(
      "account_mismatch",
      accountMismatchPrompt(deps, user, existing.email, exchanged.identity.email),
    );
  }

  const cipher = await deps.cipher();
  const refreshTokenEnc = await cipher.encrypt(exchanged.refreshToken, {
    userId: user.id,
    purpose: "refresh_token",
  });
  const accessTokenEnc = await cipher.encrypt(exchanged.accessToken, {
    userId: user.id,
    purpose: "access_token",
  });

  // Load the calendar list with the new token. Failure leaves setup able to retry.
  const api = deps.calendarApi(async () => ({ ok: true, token: exchanged.accessToken }));
  const listed = await api.listCalendars();
  const calendars: CalendarListEntry[] | null = listed.ok ? listed.value : null;

  const statements = (db: D1Database): D1PreparedStatement[] => [
    ...(replacing ? resetAccountStatements(db, user.id, now) : []),
    saveConnectionStatement(
      db,
      {
        userId: user.id,
        googleSubject: exchanged.identity.subject,
        email: exchanged.identity.email,
        scopes: exchanged.grantedScopes,
        refreshTokenEnc,
        accessTokenEnc,
        accessTokenExpiresAt: now + exchanged.expiresInSec * 1000,
      },
      now,
    ),
    // Work that stopped for reauthorization can run again.
    db
      .prepare(
        `UPDATE operations SET status = 'ready', next_attempt_at = ?1, updated_at = ?1
         WHERE user_id = ?2 AND status = 'auth_required'`,
      )
      .bind(now, user.id),
    ...(calendars ? replaceCalendarListStatements(db, user.id, calendars, now, true) : []),
    advanceSetupStatement(db, user.id, "connect", "calendars", now),
  ];

  // Persist the verified connection first; the setup prompt reads the stored calendars.
  await deps.db.batch(statements(deps.db));

  const firstTime = existing === null || replacing || user.setupStep !== "done";
  const nextUser: UserRecord = {
    ...user,
    setupStep: user.setupStep === "connect" || replacing ? "calendars" : user.setupStep,
    ...(replacing ? { defaultCalendarId: null, taskCalendarId: null } : {}),
  };
  const intro = firstTime
    ? `Google Calendar connected: ${exchanged.identity.email}.`
    : "Google Calendar reconnected. Paused changes will continue.";
  const prompt: Reaction = firstTime
    ? calendars
      ? await setupPrompt(nextUser)
      : {
          replies: [
            text(user, "I couldn't load your calendars yet. Send /start to continue setup."),
          ],
        }
    : { replies: [] };

  return finish(existing === null || replacing ? "connected" : "reconnected", {
    replies: [text(user, intro), ...prompt.replies],
    ...(prompt.statements ? { statements: prompt.statements } : {}),
  });
}

/**
 * A used state's outcome. If the callback was interrupted before recording one,
 * the persisted connection decides: never re-exchange a used code.
 */
async function priorOutcome(deps: ConnectionDeps, state: string): Promise<AuthorizationOutcome> {
  const prior = await findStateOutcome(deps.db, state);
  if (!prior) return "invalid_link";
  const recorded = OUTCOMES.find((o) => o === prior.outcome);
  if (recorded) return recorded;
  const connection = await findConnection(deps.db, prior.userId);
  return connection && connection.connectedAt >= prior.usedAt ? "connected" : "provider_failure";
}

/**
 * Switching Google accounts discards the old account's calendar links and
 * cancels changes aimed at it; tasks and settings that are not tied to the old
 * account are kept.
 */
function resetAccountStatements(db: D1Database, userId: string, now: number) {
  return [
    db.prepare("DELETE FROM calendars WHERE user_id = ?").bind(userId),
    db
      .prepare(
        `UPDATE users SET default_calendar_id = NULL, task_calendar_id = NULL,
           setup_step = 'calendars', updated_at = ? WHERE id = ?`,
      )
      .bind(now, userId),
    db
      .prepare(
        `UPDATE operations SET status = 'cancelled', error_class = 'account_replaced',
           lease_token = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE user_id = ? AND status NOT IN ('succeeded', 'failed', 'cancelled', 'applying')`,
      )
      .bind(now, userId),
  ];
}

function accountMismatchPrompt(
  deps: ConnectionDeps,
  user: UserRecord,
  currentEmail: string,
  newEmail: string,
): Reaction {
  const buttons = new ActionButtons(deps.ids, user.id, deps.clock.now());
  return {
    replies: [
      {
        method: "sendMessage",
        params: {
          chat_id: user.privateChatId,
          text: `You signed in as ${newEmail}, but ${currentEmail} is connected. Nothing was changed.\n\nSwitching accounts removes the current calendar choices.`,
          reply_markup: {
            inline_keyboard: [
              [
                buttons.button(`Switch to ${newEmail}`, "switch_account", {}),
                buttons.button(`Keep ${currentEmail}`, "keep_account", {}),
              ],
            ],
          },
        },
      },
    ],
    statements: (db, guard) => buttons.statements(db, guard),
  };
}

function text(user: UserRecord, body: string): TelegramCall {
  return { method: "sendMessage", params: { chat_id: user.privateChatId, text: body } };
}

// --- Access tokens ------------------------------------------------------------

/**
 * Supplies access tokens for one user, refreshing when needed. A refused
 * refresh marks the connection as needing reauthorization and queues one alert
 * for that connection generation.
 */
export function accessTokenSource(deps: ConnectionDeps, userId: string): AccessTokenSource {
  return async (forceRefresh) => {
    const connection = await findConnection(deps.db, userId);
    if (connection?.status !== "active") return { ok: false, reason: "auth_required" };
    const cipher = await deps.cipher();
    const now = deps.clock.now();
    try {
      if (
        !forceRefresh &&
        connection.accessTokenEnc &&
        (connection.accessTokenExpiresAt ?? 0) > now + ACCESS_TOKEN_MARGIN_MS
      ) {
        const token = await cipher.decrypt(connection.accessTokenEnc, {
          userId,
          purpose: "access_token",
        });
        return { ok: true, token };
      }
      const refreshToken = await cipher.decrypt(connection.refreshTokenEnc, {
        userId,
        purpose: "refresh_token",
      });
      const refreshed = await deps.oauth.refresh(refreshToken);
      if (refreshed.ok) {
        const enc = await cipher.encrypt(refreshed.accessToken, {
          userId,
          purpose: "access_token",
        });
        await saveAccessTokenStatement(
          deps.db,
          userId,
          connection.authGeneration,
          enc,
          now + refreshed.expiresInSec * 1000,
          now,
        ).run();
        return { ok: true, token: refreshed.accessToken };
      }
      if (refreshed.reason === "retryable") return { ok: false, reason: "retryable" };
    } catch {
      // A token that no longer decrypts (key change or tampering) needs reconnection.
      logEvent("google.token_unreadable", { userId });
    }
    await reportAuthRequired(deps, userId, connection.authGeneration);
    return { ok: false, reason: "auth_required" };
  };
}

export const AUTH_ALERT_TEXT =
  "Google Calendar access has stopped working, so I can't read or change your calendars. Reconnect to continue; nothing has been lost.";

/** Marks the connection and queues the single immediate alert for this generation. */
export async function reportAuthRequired(
  deps: ConnectionDeps,
  userId: string,
  generation: number,
): Promise<void> {
  const user = await findUserById(deps.db, userId);
  if (!user) return;
  const now = deps.clock.now();
  const buttons = new ActionButtons(deps.ids, user.id, now);
  const guard: Guard = connectionGuard(userId, generation);
  const call: TelegramCall = {
    method: "sendMessage",
    params: {
      chat_id: user.privateChatId,
      text: AUTH_ALERT_TEXT,
      reply_markup: { inline_keyboard: [[buttons.button("Reauthorize", "reconnect", {})]] },
    },
  };
  await deps.db.batch([
    markAuthRequiredStatement(deps.db, userId, generation, now),
    ...buttons.statements(deps.db, guard),
    enqueueStatement(
      deps.db,
      deps.ids,
      userId,
      { logicalKey: `auth_required:${generation}`, call },
      now,
      guard,
    ),
  ]);
  logEvent("google.auth_required", { userId, generation });
}

/** The user's Calendar adapter, or null when there is no usable connection. */
export async function connectedCalendar(
  deps: ConnectionDeps,
  userId: string,
): Promise<(CalendarPort & CalendarDirectory) | null> {
  const connection = await findConnection(deps.db, userId);
  if (connection?.status !== "active") return null;
  return deps.calendarApi(accessTokenSource(deps, userId));
}
