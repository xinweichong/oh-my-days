# ADR 0002: Serve from ohmydays.xinweichong.com and pursue Google OAuth verification

Status: Accepted; verification submission deferred by the owner on 2026-10-02 (Testing mode continues)
Date: 2026-10-02

## Context

Google Calendar scopes that read or write events are classified as sensitive.
While the OAuth app is in Testing, refresh tokens for these scopes expire after
seven days, forcing a weekly reconnect. The Google console refused to publish the
app to production without verification. Verification requires a homepage, a
privacy policy, and redirect URIs on a domain whose ownership is verified in
Google Search Console; a shared `workers.dev` hostname cannot be verified. The
owner already controls `xinweichong.com`, whose DNS is in the same Cloudflare
account that will host the Worker.

## Decision

- Serve the Worker at `ohmydays.xinweichong.com` as a Workers custom domain. The
  apex site is unaffected; the custom domain creates its own DNS record.
- Verify `xinweichong.com` in Search Console (DNS TXT record) and list it as an
  authorized domain on the OAuth consent screen.
- The Worker serves a minimal homepage (`/`) and privacy policy (`/privacy`) in
  addition to the planned connection pages, because verification requires them.
  They follow the connection-page presentation direction.
- Keep the narrow scope set: `calendar.events`, `calendar.calendarlist.readonly`,
  `calendar.app.created`, `openid`, `email`. Verification for sensitive (not
  restricted) scopes has no paid security assessment.
- Operate in Testing mode, with the owner as a test user, until verification is
  approved; the bot's reauthorization flow covers the weekly expiry meanwhile.

## Alternatives considered

- *Testing mode permanently:* free and simple, but a weekly reconnect.
- *Production without verification:* refused by the console for these scopes.
- *Buying a domain:* unnecessary since one is already owned; would conflict with
  the free-only rule.
- *Full `calendar` scope:* also sensitive, and grants sharing changes and
  deletion of existing calendars that no feature needs.

## Consequences

- Deployment identity is fixed to `ohmydays.xinweichong.com`: the Telegram webhook,
  OAuth redirect URI, and page links use it. Local development uses
  `http://localhost:8787` via `.dev.vars`.
- Homepage and privacy-policy copy must stay accurate as features change, since
  Google reviews them and users rely on them.
- Verification needs a demo video and per-scope justifications, prepared by the
  owner. Review time is outside the project's control.
- The spec's "minimal Google authorization pages" now includes these two pages.
