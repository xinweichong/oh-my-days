/**
 * Google OAuth 2.0 / OpenID Connect for a confidential web client with PKCE.
 * Results are typed; raw responses, codes, and tokens never reach logs.
 */

export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.app.created",
] as const;

/** Scopes that must actually be granted; users can untick some on Google's screen. */
export const REQUIRED_CALENDAR_SCOPES = GOOGLE_SCOPES.filter((s) => s.startsWith("https://"));

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const TIMEOUT_MS = 10_000;

export interface OAuthClientConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface GoogleIdentity {
  subject: string;
  email: string;
}

export type CodeExchangeResult =
  | {
      ok: true;
      identity: GoogleIdentity;
      refreshToken: string;
      accessToken: string;
      expiresInSec: number;
      grantedScopes: string[];
    }
  | {
      ok: false;
      reason: "invalid_grant" | "missing_refresh_token" | "invalid_identity" | "provider";
    };

export type RefreshResult =
  | { ok: true; accessToken: string; expiresInSec: number }
  /** Revoked, expired (e.g. Testing-mode 7-day limit), or otherwise unusable. */
  | { ok: false; reason: "auth_required" }
  | { ok: false; reason: "retryable" };

export interface GoogleOAuth {
  authorizationUrl(state: string, codeChallenge: string, loginHint?: string): string;
  exchangeCode(code: string, codeVerifier: string): Promise<CodeExchangeResult>;
  refresh(refreshToken: string): Promise<RefreshResult>;
}

export function createGoogleOAuth(
  config: OAuthClientConfig,
  fetchImpl: typeof fetch = fetch,
): GoogleOAuth {
  return {
    authorizationUrl(state, codeChallenge, loginHint) {
      const url = new URL(AUTH_ENDPOINT);
      url.search = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: config.redirectUri,
        response_type: "code",
        scope: GOOGLE_SCOPES.join(" "),
        // Offline access returns a refresh token; consent ensures one is issued
        // again on reconnection.
        access_type: "offline",
        prompt: "consent",
        state,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        ...(loginHint ? { login_hint: loginHint } : {}),
      }).toString();
      return url.toString();
    },

    async exchangeCode(code, codeVerifier) {
      const response = await post(fetchImpl, {
        grant_type: "authorization_code",
        code,
        code_verifier: codeVerifier,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: config.redirectUri,
      });
      if (!response) return { ok: false, reason: "provider" };
      if (!response.ok) {
        return {
          ok: false,
          reason: response.error === "invalid_grant" ? "invalid_grant" : "provider",
        };
      }
      const body = response.body;
      if (typeof body.access_token !== "string" || typeof body.expires_in !== "number") {
        return { ok: false, reason: "provider" };
      }
      if (typeof body.refresh_token !== "string")
        return { ok: false, reason: "missing_refresh_token" };
      const identity = identityFromIdToken(body.id_token, config.clientId);
      if (!identity) return { ok: false, reason: "invalid_identity" };
      return {
        ok: true,
        identity,
        refreshToken: body.refresh_token,
        accessToken: body.access_token,
        expiresInSec: body.expires_in,
        grantedScopes: typeof body.scope === "string" ? body.scope.split(" ").filter(Boolean) : [],
      };
    },

    async refresh(refreshToken) {
      const response = await post(fetchImpl, {
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: config.clientId,
        client_secret: config.clientSecret,
      });
      if (!response) return { ok: false, reason: "retryable" };
      if (!response.ok) {
        // invalid_grant: revoked, expired, or the password changed. 5xx/other: transient.
        return response.error === "invalid_grant" || response.error === "unauthorized_client"
          ? { ok: false, reason: "auth_required" }
          : { ok: false, reason: "retryable" };
      }
      const { access_token, expires_in } = response.body;
      if (typeof access_token !== "string" || typeof expires_in !== "number") {
        return { ok: false, reason: "retryable" };
      }
      return { ok: true, accessToken: access_token, expiresInSec: expires_in };
    },
  };
}

type TokenResponse =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; error: string | null };

async function post(
  fetchImpl: typeof fetch,
  form: Record<string, string>,
): Promise<TokenResponse | null> {
  let response: Response;
  try {
    response = await fetchImpl(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return null;
  }
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = await response.json();
    if (typeof parsed === "object" && parsed !== null) body = parsed as Record<string, unknown>;
  } catch {
    // Classified by status below.
  }
  if (response.ok) return { ok: true, body };
  if (response.status >= 500) return { ok: false, error: null };
  return { ok: false, error: typeof body.error === "string" ? body.error : null };
}

/**
 * Reads identity claims from an ID token received directly from Google's token
 * endpoint over TLS. OpenID Connect Core §3.1.3.7 permits relying on TLS server
 * validation instead of verifying the signature in this case; issuer, audience,
 * and a verified email are still required.
 */
export function identityFromIdToken(idToken: unknown, clientId: string): GoogleIdentity | null {
  if (typeof idToken !== "string") return null;
  const payload = idToken.split(".")[1];
  if (!payload) return null;
  let claims: Record<string, unknown>;
  try {
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    claims = JSON.parse(new TextDecoder().decode(Uint8Array.from(json, (c) => c.charCodeAt(0))));
  } catch {
    return null;
  }
  const issuerOk =
    claims.iss === "https://accounts.google.com" || claims.iss === "accounts.google.com";
  const audienceOk = claims.aud === clientId;
  if (!issuerOk || !audienceOk) return null;
  if (typeof claims.sub !== "string" || typeof claims.email !== "string") return null;
  if (claims.email_verified !== true) return null;
  return { subject: claims.sub, email: claims.email };
}

/** PKCE S256 challenge for a verifier. */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

/** 32 random bytes as base64url: a 43-character PKCE verifier or state value. */
export function randomUrlToken(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
