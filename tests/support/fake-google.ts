import type { CalendarListEntry, ProviderResult } from "../../src/calendar/port";
import type { AccessTokenSource, GoogleCalendarApi } from "../../src/google/calendar-api";
import { type GoogleOAuth, pkceChallenge, REQUIRED_CALENDAR_SCOPES } from "../../src/google/oauth";
import { FakeCalendar } from "./fake-calendar";

interface Account {
  subject: string;
  email: string;
  calendars: CalendarListEntry[];
  events: FakeCalendar;
}

interface Consent {
  subject: string;
  email: string;
  deny?: boolean;
  scopes?: string[];
}

/**
 * Synthetic Google: consent, authorization codes bound to PKCE challenges,
 * refresh tokens that can be revoked, and per-account calendars.
 */
export class FakeGoogle {
  readonly accounts = new Map<string, Account>();
  exchangeCalls = 0;
  refreshCalls = 0;
  /** Faults for the next calendars.insert: lose the response after creating. */
  createLosesResponse = false;
  private readonly codes = new Map<
    string,
    { subject: string; challenge: string; scopes: string[] }
  >();
  private readonly refreshTokens = new Map<string, { subject: string; revoked: boolean }>();
  private readonly accessTokens = new Map<string, string>();
  private counter = 0;

  account(subject: string, email: string, calendars: CalendarListEntry[] = []): Account {
    const account: Account = {
      subject,
      email,
      calendars: calendars.length
        ? calendars
        : [
            {
              calendarId: `${subject}@primary`,
              summary: email,
              accessRole: "owner",
              primary: true,
            },
          ],
      events: new FakeCalendar(),
    };
    this.accounts.set(subject, account);
    return account;
  }

  revokeAll(subject: string): void {
    for (const token of this.refreshTokens.values()) {
      if (token.subject === subject) token.revoked = true;
    }
    for (const [token, owner] of this.accessTokens) {
      if (owner === subject) this.accessTokens.delete(token);
    }
  }

  /** The user's choice on Google's consent screen; returns the callback path. */
  async consent(authorizationUrl: string, choice: Consent): Promise<string> {
    const url = new URL(authorizationUrl);
    const state = url.searchParams.get("state") ?? "";
    if (choice.deny) return `/oauth/callback?state=${state}&error=access_denied`;
    if (!this.accounts.has(choice.subject)) this.account(choice.subject, choice.email);
    const code = `code-${++this.counter}`;
    this.codes.set(code, {
      subject: choice.subject,
      challenge: url.searchParams.get("code_challenge") ?? "",
      scopes: choice.scopes ?? [...REQUIRED_CALENDAR_SCOPES, "openid", "email"],
    });
    return `/oauth/callback?state=${state}&code=${code}`;
  }

  readonly oauth: GoogleOAuth = {
    authorizationUrl: (state, codeChallenge, loginHint) => {
      const url = new URL("https://accounts.google.test/o/oauth2/v2/auth");
      url.search = new URLSearchParams({
        state,
        code_challenge: codeChallenge,
        ...(loginHint ? { login_hint: loginHint } : {}),
      }).toString();
      return url.toString();
    },
    exchangeCode: async (code, verifier) => {
      this.exchangeCalls++;
      const grant = this.codes.get(code);
      this.codes.delete(code);
      if (!grant || grant.challenge !== (await pkceChallenge(verifier))) {
        return { ok: false, reason: "invalid_grant" };
      }
      const account = this.accounts.get(grant.subject);
      if (!account) return { ok: false, reason: "provider" };
      const refreshToken = `refresh-${++this.counter}`;
      this.refreshTokens.set(refreshToken, { subject: grant.subject, revoked: false });
      return {
        ok: true,
        identity: { subject: account.subject, email: account.email },
        refreshToken,
        accessToken: this.issueAccess(grant.subject),
        expiresInSec: 3600,
        grantedScopes: grant.scopes,
      };
    },
    refresh: async (refreshToken) => {
      this.refreshCalls++;
      const token = this.refreshTokens.get(refreshToken);
      if (!token || token.revoked) return { ok: false, reason: "auth_required" };
      return { ok: true, accessToken: this.issueAccess(token.subject), expiresInSec: 3600 };
    },
  };

  /** Calendar API bound to whichever account the access token belongs to. */
  readonly calendarApi = (tokens: AccessTokenSource): GoogleCalendarApi => {
    const withAccount = async <T>(
      use: (account: Account) => Promise<ProviderResult<T>>,
    ): Promise<ProviderResult<T>> => {
      const token = await tokens(false);
      if (!token.ok) {
        return {
          ok: false,
          error:
            token.reason === "auth_required"
              ? { kind: "auth_required" }
              : { kind: "retryable", retryAfterMs: null },
        };
      }
      const subject = this.accessTokens.get(token.token);
      const account = subject ? this.accounts.get(subject) : undefined;
      if (!account) return { ok: false, error: { kind: "auth_required" } };
      return use(account);
    };
    return {
      getEvent: (c, e) => withAccount((a) => a.events.getEvent(c, e)),
      insertEvent: (c, e, f) => withAccount((a) => a.events.insertEvent(c, e, f)),
      patchEvent: (c, e, p, m) => withAccount((a) => a.events.patchEvent(c, e, p, m)),
      deleteEvent: (c, e, m) => withAccount((a) => a.events.deleteEvent(c, e, m)),
      listEventPage: async (c, cursor) => {
        const token = await tokens(false);
        const subject = token.ok ? this.accessTokens.get(token.token) : undefined;
        const account = subject ? this.accounts.get(subject) : undefined;
        if (!account) return { ok: false, error: { kind: "auth_required" } };
        return account.events.listEventPage(c, cursor);
      },
      listWindow: (c, min, max) => withAccount((a) => a.events.listWindow(c, min, max)),
      listCalendars: () => withAccount(async (a) => ({ ok: true, value: [...a.calendars] })),
      createCalendar: (summary) =>
        withAccount(async (a) => {
          const entry: CalendarListEntry = {
            calendarId: `cal-${++this.counter}@group.calendar.test`,
            summary,
            accessRole: "owner",
            primary: false,
          };
          a.calendars.push(entry);
          if (this.createLosesResponse) {
            this.createLosesResponse = false;
            return { ok: false, error: { kind: "outcome_unknown" } };
          }
          return { ok: true, value: entry };
        }),
    };
  };

  private issueAccess(subject: string): string {
    const token = `access-${++this.counter}`;
    this.accessTokens.set(token, subject);
    return token;
  }
}
