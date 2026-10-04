# Runbook: operating Oh My Days

Production: Worker `oh-my-days` at `https://ohmydays.xinweichong.com`, D1 database
`oh-my-days` (APAC), one cron trigger every minute. Deploying is covered in
[deploy.md](deploy.md). Commands run from the repository root after
`npx wrangler login`.

## Routine checks

- `/health` in Telegram: connection, last successful sync, failed checks,
  pending changes, and messages that may not have arrived.
- `GET https://ohmydays.xinweichong.com/healthz` returns `ok`.
- Counts only (no personal data):

  ```sh
  npx wrangler d1 execute oh-my-days --remote --command "SELECT
    (SELECT COUNT(*) FROM calendar_sync WHERE consecutive_failures > 0) AS failing_sync,
    (SELECT COUNT(*) FROM telegram_outbox WHERE status IN ('failed','unknown')) AS undelivered,
    (SELECT COUNT(*) FROM operations WHERE status IN ('needs_resolution','failed')) AS problem_operations"
  ```

- `npx wrangler d1 info oh-my-days` for size and 24-hour rows read/written;
  compare with [capacity](../capacity.md).
- `npx wrangler tail oh-my-days --format json` shows each invocation's `cpuTime`
  and logs (identifiers, counts, and error classes only).

## Google access stops working

The OAuth app is in Testing, so Google ends access every 7 days (ADR 0002). The
bot sends one alert with **Reauthorize**; paused changes resume after
reconnecting. Nothing else is needed. If reconnecting fails, check the OAuth
client's redirect URI (`https://ohmydays.xinweichong.com/oauth/callback`) and
that the user is still a test user on the consent screen.

## Sync outage alert

After three failed checks in a row the bot alerts once and keeps retrying with
backoff. Check `npx wrangler tail` for `sync.failed` error classes:

- `retryable`: Google unavailable or rate-limited; wait.
- `forbidden` / `not_found`: a calendar was unshared or deleted; the user can
  deselect it in `/settings → Calendars`. Its cached events are kept until then.
- `auth_required`: handled by the reauthorization alert.

## Telegram webhook

`getWebhookInfo` (see deploy.md) shows `pending_update_count` and
`last_error_message`. A 401 there means `TELEGRAM_WEBHOOK_SECRET` and the
webhook registration disagree: set the secret again and call `setWebhook`.

## Free-tier limits reached

Cloudflare stops serving the Worker or D1 queries until the daily reset at
00:00 UTC; the inbox and operations resume from D1 afterwards and missed
reminders arrive as one catch-up summary. Never enable paid overflow. If usage
grows, raise the sync interval (`SYNC_INTERVAL_MS`) or the maintenance intervals
in `src/jobs/tick.ts` first.

## Rotating secrets

| Secret | Effect of rotating |
|---|---|
| `TELEGRAM_WEBHOOK_SECRET` | Update the Worker secret, then `setWebhook` with the new value. |
| `TELEGRAM_BOT_TOKEN` | Revoke in @BotFather, update the secret, re-run `setWebhook`. |
| `GOOGLE_CLIENT_SECRET` | Create a new secret in Google Cloud, update the Worker secret; existing refresh tokens keep working. |
| `TOKEN_ENCRYPTION_KEY` | Stored Google tokens become unreadable: every user receives one Reauthorize alert. Rotate only if the key may have leaked. |

## Adding a user

Add their numeric Telegram ID to `TELEGRAM_ALLOWED_USER_IDS` (comma-separated)
with `npx wrangler secret put TELEGRAM_ALLOWED_USER_IDS`. They also need to be a
test user on the OAuth consent screen while the app is in Testing (100-user cap).
Recheck [capacity](../capacity.md) before adding many users.

## Backup and restore

- **Point in time:** D1 Time Travel restores the database to any minute in the
  retention window (7 days on the Free plan, last checked 2026-10-04):

  ```sh
  npx wrangler d1 time-travel info oh-my-days            # current bookmark
  npx wrangler d1 time-travel restore oh-my-days --timestamp=<unix-or-RFC3339>
  ```

  Restoring overwrites the live database; take a fresh bookmark first so the
  restore itself can be undone.
- **Export:** `npx wrangler d1 export oh-my-days --remote --output backup.sql`
  writes a full SQL dump. It contains personal data and encrypted tokens: keep
  it out of the repository and delete it when no longer needed.

### Restore drill

Performed 2026-10-04 without touching production: exported the live database,
restored it into a scratch local D1 (`--local --persist-to <dir>`), and compared
row counts for users, tasks, lists, calendars, connections, and migrations: all
matched. The export was then deleted. Repeat before major changes.

## Rollback

`npx wrangler deployments list` shows versions; `npx wrangler rollback <version-id>`
restores one. Rollback does not undo D1 migrations, so migrations are additive
and older code must tolerate new columns. Rollback was exercised on 2026-10-04
(see [capacity](../capacity.md#rollback-drill)).

## Deleting a user's data

On request (privacy policy: within 30 days). Replace `<id>` with the user's
internal ID (`SELECT id FROM users WHERE telegram_user_id = …`). Order respects
foreign keys:

```sql
DELETE FROM callback_refs WHERE user_id = '<id>';
DELETE FROM operations WHERE user_id = '<id>';
DELETE FROM ui_actions WHERE user_id = '<id>';
DELETE FROM pending_inputs WHERE user_id = '<id>';
DELETE FROM reminder_log WHERE user_id = '<id>';
DELETE FROM reminder_overrides WHERE user_id = '<id>';
DELETE FROM agenda_runs WHERE user_id = '<id>';
DELETE FROM event_horizon WHERE user_id = '<id>';
DELETE FROM event_cache WHERE user_id = '<id>';
DELETE FROM calendar_sync WHERE user_id = '<id>';
DELETE FROM calendars WHERE user_id = '<id>';
DELETE FROM tasks WHERE user_id = '<id>';
DELETE FROM task_series WHERE user_id = '<id>';
DELETE FROM task_lists WHERE user_id = '<id>';
DELETE FROM contacts WHERE user_id = '<id>';
DELETE FROM connect_links WHERE user_id = '<id>';
DELETE FROM oauth_states WHERE user_id = '<id>';
DELETE FROM google_connections WHERE user_id = '<id>';
DELETE FROM telegram_outbox WHERE user_id = '<id>';
DELETE FROM telegram_inbox WHERE user_id = '<id>';
DELETE FROM users WHERE id = '<id>';
```

Also remove their ID from `TELEGRAM_ALLOWED_USER_IDS`. Markers in their Google
Calendar remain theirs; they can revoke access at
https://myaccount.google.com/connections.
