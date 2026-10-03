import type { AccessRole, CalendarListEntry } from "../calendar/port";
import type { Guard } from "./guard";

export type LinkPurpose = "connect" | "reconnect" | "replace";

export interface ConnectionRecord {
  userId: string;
  googleSubject: string;
  email: string;
  scopes: string[];
  refreshTokenEnc: string;
  accessTokenEnc: string | null;
  accessTokenExpiresAt: number | null;
  status: "active" | "auth_required";
  authGeneration: number;
  connectedAt: number;
}

interface ConnectionRow {
  user_id: string;
  google_subject: string;
  email: string;
  scopes: string;
  refresh_token_enc: string;
  access_token_enc: string | null;
  access_token_expires_at: number | null;
  status: "active" | "auth_required";
  auth_generation: number;
  connected_at: number;
}

export async function findConnection(
  db: D1Database,
  userId: string,
): Promise<ConnectionRecord | null> {
  const row = await db
    .prepare(
      `SELECT user_id, google_subject, email, scopes, refresh_token_enc, access_token_enc,
         access_token_expires_at, status, auth_generation, connected_at
       FROM google_connections WHERE user_id = ?`,
    )
    .bind(userId)
    .first<ConnectionRow>();
  if (!row) return null;
  return {
    userId: row.user_id,
    googleSubject: row.google_subject,
    email: row.email,
    scopes: row.scopes.split(" ").filter(Boolean),
    refreshTokenEnc: row.refresh_token_enc,
    accessTokenEnc: row.access_token_enc,
    accessTokenExpiresAt: row.access_token_expires_at,
    status: row.status,
    authGeneration: row.auth_generation,
    connectedAt: row.connected_at,
  };
}

export interface NewConnection {
  userId: string;
  googleSubject: string;
  email: string;
  scopes: string[];
  refreshTokenEnc: string;
  accessTokenEnc: string;
  accessTokenExpiresAt: number;
}

/** Stores a (re)connection; each one starts a new auth generation. */
export function saveConnectionStatement(
  db: D1Database,
  c: NewConnection,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO google_connections (user_id, google_subject, email, scopes, refresh_token_enc,
         access_token_enc, access_token_expires_at, status, connected_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'active', ?8, ?8)
       ON CONFLICT (user_id) DO UPDATE SET
         google_subject = excluded.google_subject, email = excluded.email,
         scopes = excluded.scopes, refresh_token_enc = excluded.refresh_token_enc,
         access_token_enc = excluded.access_token_enc,
         access_token_expires_at = excluded.access_token_expires_at, status = 'active',
         auth_generation = google_connections.auth_generation + 1,
         connected_at = excluded.connected_at, updated_at = excluded.updated_at`,
    )
    .bind(
      c.userId,
      c.googleSubject,
      c.email,
      c.scopes.join(" "),
      c.refreshTokenEnc,
      c.accessTokenEnc,
      c.accessTokenExpiresAt,
      now,
    );
}

/** Caches a refreshed access token, only for the generation it was refreshed under. */
export function saveAccessTokenStatement(
  db: D1Database,
  userId: string,
  generation: number,
  accessTokenEnc: string,
  expiresAt: number,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE google_connections SET access_token_enc = ?, access_token_expires_at = ?, updated_at = ?
       WHERE user_id = ? AND auth_generation = ? AND status = 'active'`,
    )
    .bind(accessTokenEnc, expiresAt, now, userId, generation);
}

/**
 * Marks the connection as needing reauthorization. Changes a row only on the
 * first failure of a generation, which keys the single immediate alert.
 */
export function markAuthRequiredStatement(
  db: D1Database,
  userId: string,
  generation: number,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE google_connections SET status = 'auth_required', access_token_enc = NULL,
         access_token_expires_at = NULL, updated_at = ?
       WHERE user_id = ? AND auth_generation = ? AND status = 'active'`,
    )
    .bind(now, userId, generation);
}

export function connectionGuard(userId: string, generation: number): Guard {
  return {
    sql: "EXISTS (SELECT 1 FROM google_connections WHERE user_id = ? AND auth_generation = ? AND status = 'auth_required')",
    params: [userId, generation],
  };
}

// --- Connect links (sent in Telegram) ---

export function insertConnectLinkStatement(
  db: D1Database,
  token: string,
  userId: string,
  purpose: LinkPurpose,
  expiresAt: number,
  now: number,
  guard: Guard,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO connect_links (token, user_id, purpose, expires_at, created_at)
       SELECT ?, ?, ?, ?, ? WHERE ${guard.sql}`,
    )
    .bind(token, userId, purpose, expiresAt, now, ...guard.params);
}

export async function findUsableLink(
  db: D1Database,
  token: string,
  now: number,
): Promise<{ userId: string; purpose: LinkPurpose } | null> {
  const row = await db
    .prepare(
      "SELECT user_id, purpose FROM connect_links WHERE token = ? AND used_at IS NULL AND expires_at > ?",
    )
    .bind(token, now)
    .first<{ user_id: string; purpose: LinkPurpose }>();
  return row ? { userId: row.user_id, purpose: row.purpose } : null;
}

/** Atomically consumes a usable link. */
export async function consumeLink(
  db: D1Database,
  token: string,
  now: number,
): Promise<{ userId: string; purpose: LinkPurpose } | null> {
  const row = await db
    .prepare(
      `UPDATE connect_links SET used_at = ?1
       WHERE token = ?2 AND used_at IS NULL AND expires_at > ?1
       RETURNING user_id, purpose`,
    )
    .bind(now, token)
    .first<{ user_id: string; purpose: LinkPurpose }>();
  return row ? { userId: row.user_id, purpose: row.purpose } : null;
}

// --- OAuth state ---

export function insertOAuthStateStatement(
  db: D1Database,
  state: string,
  userId: string,
  purpose: LinkPurpose,
  codeVerifier: string,
  expiresAt: number,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO oauth_states (state, user_id, purpose, code_verifier, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(state, userId, purpose, codeVerifier, expiresAt, now);
}

export interface ConsumedState {
  userId: string;
  purpose: LinkPurpose;
  codeVerifier: string;
}

export async function consumeOAuthState(
  db: D1Database,
  state: string,
  now: number,
): Promise<ConsumedState | null> {
  const row = await db
    .prepare(
      `UPDATE oauth_states SET used_at = ?1
       WHERE state = ?2 AND used_at IS NULL AND expires_at > ?1
       RETURNING user_id, purpose, code_verifier`,
    )
    .bind(now, state)
    .first<{ user_id: string; purpose: LinkPurpose; code_verifier: string }>();
  return row
    ? { userId: row.user_id, purpose: row.purpose, codeVerifier: row.code_verifier }
    : null;
}

/** An already-used state and its recorded outcome, for a refreshed callback page. */
export async function findStateOutcome(
  db: D1Database,
  state: string,
): Promise<{ outcome: string | null; userId: string; usedAt: number } | null> {
  const row = await db
    .prepare(
      "SELECT outcome, user_id, used_at FROM oauth_states WHERE state = ? AND used_at IS NOT NULL",
    )
    .bind(state)
    .first<{ outcome: string | null; user_id: string; used_at: number }>();
  return row ? { outcome: row.outcome, userId: row.user_id, usedAt: row.used_at } : null;
}

export function recordStateOutcomeStatement(
  db: D1Database,
  state: string,
  outcome: string,
): D1PreparedStatement {
  // The verifier is no longer needed once the code has been exchanged or refused.
  return db
    .prepare("UPDATE oauth_states SET outcome = ?, code_verifier = '' WHERE state = ?")
    .bind(outcome, state);
}

export function purgeExpiredAuthStatements(
  db: D1Database,
  olderThan: number,
  limit: number,
): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `DELETE FROM connect_links WHERE token IN (
           SELECT token FROM connect_links WHERE expires_at < ? LIMIT ?)`,
      )
      .bind(olderThan, limit),
    db
      .prepare(
        `DELETE FROM oauth_states WHERE state IN (
           SELECT state FROM oauth_states WHERE expires_at < ? LIMIT ?)`,
      )
      .bind(olderThan, limit),
  ];
}

// --- Calendars ---

export interface StoredCalendar extends CalendarListEntry {
  selected: boolean;
  listed: boolean;
}

interface CalendarRow {
  calendar_id: string;
  summary: string;
  access_role: AccessRole;
  is_primary: number;
  selected: number;
  listed: number;
}

/**
 * Replaces the cached calendar list after a complete listing. Calendars missing
 * from the list are marked unlisted, never deleted, and keep their selection
 * state so a temporary absence does not lose settings.
 */
export function replaceCalendarListStatements(
  db: D1Database,
  userId: string,
  entries: readonly CalendarListEntry[],
  now: number,
  preselectPrimary: boolean,
): D1PreparedStatement[] {
  return [
    db
      .prepare("UPDATE calendars SET listed = 0, updated_at = ? WHERE user_id = ?")
      .bind(now, userId),
    ...entries.map((e) =>
      upsertCalendarStatement(db, userId, e, now, preselectPrimary && e.primary),
    ),
  ];
}

export function upsertCalendarStatement(
  db: D1Database,
  userId: string,
  entry: CalendarListEntry,
  now: number,
  selectIfNew: boolean,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO calendars (user_id, calendar_id, summary, access_role, is_primary, selected,
         listed, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT (user_id, calendar_id) DO UPDATE SET
         summary = excluded.summary, access_role = excluded.access_role,
         is_primary = excluded.is_primary, listed = 1, updated_at = excluded.updated_at`,
    )
    .bind(
      userId,
      entry.calendarId,
      entry.summary,
      entry.accessRole,
      entry.primary ? 1 : 0,
      selectIfNew ? 1 : 0,
      now,
    );
}

export async function listStoredCalendars(
  db: D1Database,
  userId: string,
): Promise<StoredCalendar[]> {
  const { results } = await db
    .prepare(
      `SELECT calendar_id, summary, access_role, is_primary, selected, listed
       FROM calendars WHERE user_id = ? ORDER BY is_primary DESC, summary COLLATE NOCASE`,
    )
    .bind(userId)
    .all<CalendarRow>();
  return results.map((r) => ({
    calendarId: r.calendar_id,
    summary: r.summary,
    accessRole: r.access_role,
    primary: r.is_primary === 1,
    selected: r.selected === 1,
    listed: r.listed === 1,
  }));
}

export function setCalendarSelectedStatement(
  db: D1Database,
  userId: string,
  calendarId: string,
  selected: boolean,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      "UPDATE calendars SET selected = ?, updated_at = ? WHERE user_id = ? AND calendar_id = ?",
    )
    .bind(selected ? 1 : 0, now, userId, calendarId);
}
