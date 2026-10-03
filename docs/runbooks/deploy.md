# Runbook: deploy and operate

Production: Worker `oh-my-days` at `https://ohmydays.xinweichong.com`, D1
database `oh-my-days` (APAC), one cron trigger (`* * * * *`). First deployed
2026-10-03 from `feature/google-connection`.

## Deploy a change

```sh
npm run check                                      # must pass first
npx wrangler d1 migrations apply oh-my-days --remote   # only when migrations/ changed
npx wrangler deploy
```

Apply migrations before deploying code that depends on them. Migrations are
append-only once applied remotely; never edit an applied migration.

## Secrets

Set with `npx wrangler secret put <NAME>`; list names with `npx wrangler secret list`.
Required: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_ALLOWED_USER_IDS`,
`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `TOKEN_ENCRYPTION_KEY`. Non-secret
settings (`PUBLIC_BASE_URL`, `TELEGRAM_BOT_USERNAME`, `CONTACT_EMAIL`) live in
`wrangler.jsonc`. Never upload `PUBLIC_BASE_URL` as a secret.

Changing `TOKEN_ENCRYPTION_KEY` makes stored Google tokens unreadable: users
receive one Reauthorize alert and must reconnect.

## Telegram webhook

Registered with `setWebhook` to `/telegram/webhook`, the `TELEGRAM_WEBHOOK_SECRET`
as `secret_token`, and `allowed_updates: ["message", "callback_query"]`. Check with
`getWebhookInfo` (look at `pending_update_count` and `last_error_message`).
After rotating the webhook secret, update the Worker secret and call `setWebhook` again.

## Checks after deploying

- `GET /healthz` returns `ok`; `/` and `/privacy` return 200.
- Send `/health` to the bot.
- `npx wrangler tail` streams logs (identifiers and error classes only).

## Google OAuth

The OAuth app is in Testing (verification deferred; ADR 0002), so refresh tokens
expire after 7 days and the bot asks for reauthorization. Redirect URI:
`https://ohmydays.xinweichong.com/oauth/callback`.

## Rollback

`npx wrangler rollback` restores the previous Worker version. It does not undo
D1 migrations; keep migrations backward-compatible with the previous version.
