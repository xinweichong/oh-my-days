# Runbook: onboarding a few more users

How the owner adds up to four other people (five users in all) to the existing
deployment. Nothing new is provisioned: everyone shares the one Worker, D1
database, cron trigger, Telegram bot, and Google OAuth client. Each user's data
is kept separate by user ID in every table and lookup, so adding someone
means changing two access lists and nothing else.

Production details and commands are in [deploy.md](deploy.md) and
[operations.md](operations.md). `<host>` is the production host, and commands
run from the repository root after `npx wrangler login`.

## 1. What is shared, and what that means

| Shared piece | Effect on other users |
|---|---|
| Worker and cron (one run a minute) | Everyone's syncs, reminders, and agendas share the same per-minute work. Each run syncs at most one calendar ([capacity](../capacity.md)) |
| D1 database | One set of free-tier allowances (5M rows read, 100k rows written a day). If the limit is hit, everything pauses for **everyone** until 00:00 UTC |
| Telegram bot | Same bot and name for everyone. Each person talks to it in their own private chat; group chats are ignored |
| Google OAuth client (in Testing) | Each person signs in with their own Google account and must be on the test-user list. Each person has to reconnect every 7 days |
| `TOKEN_ENCRYPTION_KEY` | One key for everyone's stored Google tokens. Rotating it makes every user reconnect |

Two consequences to tell people before inviting them:

- **The owner can see their data.** The owner can query D1 and holds the
  encryption key, so in practice they can read anyone's tasks, cached event
  titles and times, and Google account email. The [privacy policy](https://<host>/privacy)
  says the service is "run by an individual for invited users". Say this plainly
  when you invite someone.
- **It is best effort.** It runs on free tiers with no paid fallback. A bad
  day for one person (for example, a calendar with thousands of changes) can
  delay everyone's syncs.

## 2. Before the first invite (once)

1. **Measure current usage.** [Capacity](../capacity.md) says live rows read
   and CPU have not been remeasured since the idle-tick change (B4). Do that
   now:

   ```sh
   npx wrangler d1 info oh-my-days     # rows read/written in the last 24 h
   npx wrangler tail oh-my-days --format json   # watch cpuTime for ~15 minutes
   ```

   Record the figures in `docs/capacity.md`. Rows read grow about linearly with
   users and selected calendars. As a rough limit, keep 24-hour rows read under
   **2.5M** (the operating target) after adding people. If one user already
   uses more than 500k, measure again after each new user.

2. **Know the sync limit.** Each calendar is checked every 5 minutes, but each
   minute's run syncs only one calendar, so about **five selected calendars**
   stay on schedule. With 15 selected calendars across five users, each one
   is checked about every 15 minutes. Reminders still re-read the event from
   Google before sending, and views read Google live. What gets slower is
   noticing changes made outside the bot. Ask each person to select only the
   calendars they need. If this becomes a problem, raise `TICK_LIMITS.calendars`
   in `src/jobs/tick.ts` only after checking `cpuTime` (Workers Free allows
   10 ms per run).

3. **Know the per-run query limit.** Workers Free allows 50 D1 queries in
   each invocation, and each minute's run does all its work inside that: inbox,
   changes, one calendar sync, then the agendas and reminders of every user
   due (up to 20). A morning agenda takes about 13 queries. If several people
   get their agenda in the same minute (the same timezone and agenda hour),
   one run may go over the limit. This hasn't been measured with more than one
   user. The run would then stop partway. The agendas already queued are kept,
   the rest follow in the next minutes, and messages may go out a few minutes
   late. To spread the load, ask people to pick different agenda hours in
   `/settings` (6–11am), and check `wrangler tail` for failed runs around 8am
   after each new user.

4. **Set a contact address.** Make sure `CONTACT_EMAIL` is set in
   `wrangler.production.local.json` so `/privacy` shows where to ask for
   deletion. You have to delete within 30 days of a request.

5. **Keep the allowlist somewhere safe.** `TELEGRAM_ALLOWED_USER_IDS` is a
   Worker secret, and secrets can't be read back. Keep the current list
   (including your own ID) in a password manager, because every change replaces
   the whole value.

## 3. Add a user

Do these in order. The user can't finish setup until both lists include them.

### 3.1 Get two identifiers from them

- **Telegram numeric user ID**, for example `123456789` (not their @username).
  Telegram doesn't show it in the app. Ask them to message
  [@userinfobot](https://t.me/userinfobot) and send you the `Id` it replies with.
- **The Google account email** they will connect. Google Workspace accounts
  (work or school) can be blocked by their admin from using unverified apps.
  A personal Gmail account always works.

### 3.2 Add them as a Google test user

The OAuth app is in Testing ([ADR 0002](../adr/0002-custom-domain-and-oauth-verification.md)),
so only listed accounts can sign in.

1. Google Cloud console → the project → **Google Auth Platform → Audience**
   (older consoles call this **OAuth consent screen**).
2. Under **Test users**, choose **Add users** and enter their Google email.
3. Save. Testing allows up to 100 test users. Capacity limits you long before that.

### 3.3 Add them to the Telegram allowlist

```sh
npx wrangler secret put TELEGRAM_ALLOWED_USER_IDS
# paste the full list, comma-separated, yours included: 111111111,123456789
```

This deploys a new Worker version straight away. No `npm run deploy` is needed,
and no migration is needed. The Mini App (`/app`) checks the same list, so they
can use it too.

Common mistake: pasting only the new ID. That locks you out. If that happens,
run the command again with the full list.

### 3.4 Send them the invite

Copy and adjust:

> I've added you to Oh My Days, a Telegram assistant for your Google Calendar
> and tasks. Open https://t.me/<bot username> and send /start.
>
> - It gives you a link to connect Google Calendar (valid for 10 minutes).
>   Google will warn that the app isn't verified. Choose **Advanced → Go to
>   Oh My Days** (or **Continue**), and allow both calendar permissions.
> - Back in Telegram: choose which calendars to include, the default calendar
>   for new events, and your timezone. It creates a calendar called
>   **Tasks - Oh My Days** for task deadlines.
> - Every 7 days Google ends access while the app is in testing. The bot warns
>   you a day before with a **Reconnect** button.
> - Send /help for examples. **Open app** (or /app) shows your tasks and week.
> - I run it myself, and in principle I can see what it stores (tasks, event
>   titles and times). The privacy policy is at https://<host>/privacy. Ask me
>   any time to delete your data.

### 3.5 Check it worked

- They should get the "Connect Google Calendar" message after `/start`. If they
  get **"This bot is private."**, their ID isn't on the allowlist (see §6).
- After they finish setup, ask them to send `/health`. It should show a
  connection and a recent successful sync.
- From your side, counts only:

  ```sh
  npx wrangler d1 execute oh-my-days --remote --config wrangler.production.jsonc --command "SELECT
    (SELECT COUNT(*) FROM users) AS users,
    (SELECT COUNT(*) FROM google_connections) AS connections,
    (SELECT COUNT(*) FROM calendars WHERE selected = 1) AS selected_calendars"
  ```

  If `selected_calendars` is well above five, expect slower outside-change
  detection (§2.2).

- Next day: `npx wrangler d1 info oh-my-days`, then record rows read in
  `docs/capacity.md`.

## 4. Running it with several users

- **Weekly reconnects** are per person. A missed reconnect only pauses that
  person's sync. Their changes wait and resume after they reconnect.
- **Support.** Logs (`wrangler tail`) contain user IDs and error classes, not
  message text. To find someone's internal ID:
  `SELECT id FROM users WHERE telegram_user_id = <their Telegram ID>`.
- **Secret rotation.** Rotating `TOKEN_ENCRYPTION_KEY` sends everyone a
  Reauthorize alert. Warn people first.
- **Releases.** A deploy or rollback affects everyone at once. Migrations stay
  additive ([deploy.md](deploy.md#rollback)).
- **Free-tier exhaustion** pauses everyone until 00:00 UTC. Missed reminders
  then arrive as one catch-up summary each ([operations.md](operations.md#free-tier-limits-reached)).
- **More than five people** is outside this runbook. Measure again first, and
  consider Google verification (ADR 0002), which removes the 7-day reconnect
  and the test-user list.

## 5. Remove a user

**Removing someone from the allowlist isn't enough.** The allowlist only filters
incoming messages and Mini App requests. Scheduled work (calendar sync, the
daily agenda, reminders) runs for every user record in D1, so a removed person
would keep getting agendas and reminders, and their calendars would keep syncing.

1. Delete their data with the SQL in
   [operations.md → Deleting a user's data](operations.md#deleting-a-users-data).
   Use `--remote --config wrangler.production.jsonc`, and take a Time Travel
   bookmark first.
2. Update `TELEGRAM_ALLOWED_USER_IDS` with the remaining IDs (§3.3).
3. Remove their Google email from **Test users**.
4. Tell them they can delete the **Tasks - Oh My Days** calendar, and revoke
   access at https://myaccount.google.com/connections. Deadline entries in
   their calendar stay theirs.

If they write to the bot later, they get "This bot is private." and nothing is
stored.

## 6. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Bot replies "This bot is private." | Their ID isn't in `TELEGRAM_ALLOWED_USER_IDS`, they used their @username instead of the numeric ID, or they wrote from a group | Check the ID with @userinfobot, then set the full list again |
| Google shows "Access blocked … has not completed the Google verification process" (403 `access_denied`) | Their Google email isn't a test user, or they signed in with a different account | Add that exact email under Test users, then send `/start` again for a new link |
| Google shows "This app is blocked" or an admin message | A Workspace admin blocks unverified apps | Use a personal Google account |
| Connection link says it expired | Links last 10 minutes | Send `/start` again for a new one |
| Mini App says `not_allowed` | Same allowlist as the chat | Fix the allowlist |
| Reminders or agenda stopped after a week | Weekly Testing expiry | They tap **Reconnect** in the bot's alert |
| You stopped getting messages from the bot after a change | Your own ID was left out of the allowlist | Set the full list again, yours included |
