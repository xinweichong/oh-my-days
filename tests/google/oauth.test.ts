import { describe, expect, it } from "vitest";
import { createGoogleOAuth, GOOGLE_SCOPES, pkceChallenge } from "../../src/google/oauth";
import { CLIENT_ID, googleClaims, idToken } from "../support/google-tokens";

const config = {
  clientId: CLIENT_ID,
  clientSecret: "secret",
  redirectUri: "https://ohmydays.test/oauth/callback",
};

function tokenEndpoint(status: number, body: unknown, seen: URLSearchParams[] = []): typeof fetch {
  return async (_input, init) => {
    seen.push(new URLSearchParams(String(init?.body)));
    return new Response(JSON.stringify(body), { status });
  };
}

const granted = {
  access_token: "access-1",
  expires_in: 3599,
  refresh_token: "refresh-1",
  scope: GOOGLE_SCOPES.filter((s) => s.startsWith("https://")).join(" "),
  id_token: idToken(googleClaims("sub-1", "owner@example.com")),
};

describe("Google OAuth", () => {
  it("requests offline access with exactly the chosen scopes and PKCE", async () => {
    const url = new URL(createGoogleOAuth(config).authorizationUrl("state-1", "challenge-1"));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("scope")?.split(" ")).toEqual([...GOOGLE_SCOPES]);
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("redirect_uri")).toBe(config.redirectUri);
    expect(url.searchParams.get("state")).toBe("state-1");
  });

  it("computes the RFC 7636 S256 challenge", async () => {
    // Test vector from RFC 7636 Appendix B.
    expect(await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("exchanges a code with the verifier and reads the account identity", async () => {
    const seen: URLSearchParams[] = [];
    const oauth = createGoogleOAuth(config, tokenEndpoint(200, granted, seen));
    const result = await oauth.exchangeCode("code-1", "verifier-1");
    expect(result).toMatchObject({
      ok: true,
      identity: { subject: "sub-1", email: "owner@example.com" },
      refreshToken: "refresh-1",
    });
    expect(seen[0]?.get("code_verifier")).toBe("verifier-1");
    expect(seen[0]?.get("grant_type")).toBe("authorization_code");
  });

  it("rejects identity tokens for another client or an unverified email", async () => {
    for (const claims of [
      { ...googleClaims("sub-1", "a@example.com"), aud: "someone-else" },
      { ...googleClaims("sub-1", "a@example.com"), email_verified: false },
      { ...googleClaims("sub-1", "a@example.com"), iss: "https://evil.example" },
    ]) {
      const oauth = createGoogleOAuth(
        config,
        tokenEndpoint(200, { ...granted, id_token: idToken(claims) }),
      );
      expect(await oauth.exchangeCode("c", "v")).toEqual({ ok: false, reason: "invalid_identity" });
    }
  });

  it("requires a refresh token for ongoing access", async () => {
    const { refresh_token: _omit, ...withoutRefresh } = granted;
    const oauth = createGoogleOAuth(config, tokenEndpoint(200, withoutRefresh));
    expect(await oauth.exchangeCode("c", "v")).toEqual({
      ok: false,
      reason: "missing_refresh_token",
    });
  });

  it("distinguishes revoked access from temporary refresh failures", async () => {
    const revoked = createGoogleOAuth(config, tokenEndpoint(400, { error: "invalid_grant" }));
    expect(await revoked.refresh("r")).toEqual({ ok: false, reason: "auth_required" });
    const down = createGoogleOAuth(config, tokenEndpoint(503, {}));
    expect(await down.refresh("r")).toEqual({ ok: false, reason: "retryable" });
    const offline = createGoogleOAuth(config, async () => {
      throw new TypeError("network");
    });
    expect(await offline.refresh("r")).toEqual({ ok: false, reason: "retryable" });
  });
});
