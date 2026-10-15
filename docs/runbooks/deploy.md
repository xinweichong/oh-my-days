# Runbook: deploy and operate

Production: Worker `oh-my-days` on a custom domain, D1 database `oh-my-days`
(APAC), one cron trigger (`* * * * *`). First deployed 2026-10-03 from
`feature/google-connection`. `<host>` below means the production host.

## Production values

The repository holds no production values. `wrangler.jsonc` is shared by local
development, tests, and deploys, with a placeholder database ID. The production
host, D1 database ID, bot username, and contact address live in
`wrangler.production.local.json` (untracked; start from
`wrangler.production.example.json`). `scripts/production-config.mjs` merges the
two into `wrangler.production.jsonc` (untracked), which the deploy commands use.
Keep a copy of `wrangler.production.local.json` somewhere safe outside the
repository; without it, deploys stop with a message naming what is missing.

## Deploy a change

```sh
npm run db:migrate:remote   # only when migrations/ changed
npm run deploy              # runs npm run check, writes the production config, deploys
```

Never run a bare `npx wrangler deploy`: it uses the shared config and fails on
the placeholder database ID. Other Wrangler commands that act on production
(`tail`, `rollback`, `secret`, `d1 execute --remote`) find the Worker by name and
work as before; for `d1` commands pass `--config wrangler.production.jsonc`.

Apply migrations before deploying code that depends on them. Migrations are
append-only once applied remotely; never edit an applied migration.

## Secrets

Set with `npx wrangler secret put <NAME>`; list names with `npx wrangler secret list`.
Required: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_ALLOWED_USER_IDS`,
`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `TOKEN_ENCRYPTION_KEY`. Non-secret
settings (`PUBLIC_BASE_URL`, `TELEGRAM_BOT_USERNAME`, `CONTACT_EMAIL`) live in
`wrangler.production.local.json`. Never upload `PUBLIC_BASE_URL` as a secret.

Changing `TOKEN_ENCRYPTION_KEY` makes stored Google tokens unreadable: users
receive one Reauthorize alert and must reconnect.

## Telegram webhook

Registered with `setWebhook` to `/telegram/webhook`, the `TELEGRAM_WEBHOOK_SECRET`
as `secret_token`, and `allowed_updates: ["message", "callback_query"]`. Check with
`getWebhookInfo` (look at `pending_update_count` and `last_error_message`).
After rotating the webhook secret, update the Worker secret and call `setWebhook` again.

## Checks after deploying

- `GET /healthz` returns `ok tick_age_s=…` once the first scheduled tick has run (503 `stale …` before that, or when no tick has finished for 10 minutes); `/` (the landing page) and `/privacy` return 200.
- Send `/health` to the bot.
- `npx wrangler tail` streams logs (identifiers and error classes only).

## Google OAuth

The OAuth app is in Testing (verification deferred; ADR 0002), so refresh tokens
expire after 7 days and the bot asks for reauthorization. Redirect URI:
`https://<host>/oauth/callback`.

## Mini App (one-time, owner)

The Mini App is served at `/app` by the same Worker ([ADR 0005](../adr/0005-mini-app-surface-and-initdata-auth.md)).
After the first deploy that includes it:

1. In @BotFather: `/mybots` → the bot → Bot Settings → Configure Mini App →
   enable it with `https://<host>/app`. Leave the Menu Button
   as the command list.
2. In the chat, send `/start`: the persistent **Open app** keyboard button
   appears. Pressing it makes the bot send an inline **Open app** button
   (keyboard launches carry no sign-in data, so the app opens from that).
3. Open the app from the inline button, the agenda, `/daily`, `/tasks`, and the
   bot profile's **Open App**, on iOS, Android, and desktop as available. Check
   Home, completing a task (and Undo), snoozing, quick add, and that the
   ✓ marker appears in Google Calendar.
4. If anything fails, the chat keeps working unchanged; `/app/api/*` returns
   short error codes only (`unauthorized`, `expired`, `setup_incomplete`).

## Release a version

Releases follow [Semantic Versioning](https://semver.org) and are recorded in
[CHANGELOG.md](../../CHANGELOG.md).

1. On a `release/<version>` branch from the integrated work: set `version` in
   `package.json` (and the lockfile with `npm install --package-lock-only`), move
   the changelog entries under the new version and date, and update the README's
   version badge. The check badge follows CI on `main` by itself.
2. `npm run check`, then merge into `develop`, then `develop` into `main`, each by
   pull request.
3. Tag the merge commit on `main` (`git tag -a v2.0.0 -m "Oh My Days v2.0.0"`),
   push the tag, and create the GitHub release from the changelog entry.
4. Deploy from `main` with `npm run deploy`.

## Landing page

The landing page at `/` is built from `landing/src` into `landing/dist` and
served as static assets by the same Worker ([ADR 0006](../adr/0006-landing-page-as-static-assets.md)).
`npm run deploy` builds it; the bot link and public origin come from
`wrangler.production.local.json`. After deploying, check that `/` shows the
page, **Open in Telegram** opens the bot, and `/privacy` still returns the
policy.

## Move to a new host

Used once to move from the old host to `oh-my-days.xinweichong.com` (owner,
2026-10-15; the old host is dropped at cutover). Connecting Google, the
webhook, and the Mini App stop working until these are all done, so do them
together, right after the deploy:

1. In `wrangler.production.local.json`, set `routes[0].pattern` and
   `vars.PUBLIC_BASE_URL` to the new host, then `npm run deploy`. Wrangler
   attaches the new custom domain; remove the old one from the Worker's
   Domains in the Cloudflare dashboard.
2. Google Cloud console, OAuth client: add the redirect URI
   `https://<new host>/oauth/callback` (remove the old one afterwards). On the
   consent screen, set the homepage to `https://<new host>/` and the privacy
   policy to `https://<new host>/privacy`. The authorized domain is the parent
   domain, so it normally needs no change; if Search Console verified only the
   old subdomain, verify the new one too.
3. Telegram: call `setWebhook` with `https://<new host>/telegram/webhook`, the
   same `secret_token` and `allowed_updates`, then check `getWebhookInfo`.
4. BotFather: Configure Mini App with `https://<new host>/app`.
5. Run the checks below, send `/health` and `/app`, and connect Google once
   with `/connect` to confirm the redirect.

Links in already-sent messages (connection links, Open app buttons) point to
the old host and stop working; the bot sends fresh ones on request.

## Rollback

`npx wrangler rollback` restores the previous Worker version. It does not undo
D1 migrations; keep migrations backward-compatible with the previous version.
