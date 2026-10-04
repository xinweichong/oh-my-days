# Acceptance matrix

Status as of 2026-10-04. Maps every acceptance scenario in the
[specification](specs/oh-my-days.md) §12 to its evidence, and every validation
item in §13 to its result. "Test" evidence runs in `npm test` (Workers runtime,
local D1, fake Google and Telegram); "Live" evidence was observed on the
deployed Worker with the owner's accounts.

Natural-language interpretation (backend stage 9) is **deferred by the owner on
2026-10-04**. It remains in scope; rows that depend on it are marked
**Deferred**, and their structured equivalents are listed where they exist.

## Spec §12 acceptance scenarios

| # | Scenario | Status | Evidence |
|---|---|---|---|
| 1 | `Dinner Friday at 7pm` → event, 7–8pm, result with Undo, one-hour reminder | Structured ✓; natural language **Deferred** | `tests/flows/events.test.ts` "guides title, day, time, and length…"; `tests/flows/reminders.test.ts` "reminds one hour before a timed event, once" |
| 2 | `Call Alex tomorrow at 3pm` → event by default | **Deferred** (needs interpretation) | — |
| 3 | `Remind me to buy milk tomorrow` → task due tomorrow, marker, 8am agenda | Structured ✓; natural language **Deferred** | `tests/flows/tasks.test.ts` "projects a date-only deadline…"; `tests/flows/reminders.test.ts` agenda "Due today" |
| 4 | `Buy milk` → open-ended Inbox task, no calendar entry | Structured ✓ | `tests/flows/tasks.test.ts` "adds an open-ended Inbox task…" |
| 5 | Task due tomorrow 3pm → marker at 3pm, agenda, 2pm reminder | ✓ | `tests/flows/tasks.test.ts` "preserves an exact due time…"; `tests/flows/reminders.test.ts` "reminds one hour before an exact-time deadline…"; owner checked markers live |
| 6 | Snooze an overdue task → deadline unchanged; out of overdue summaries until expiry | ✓ | `tests/flows/reminders.test.ts` "leaves a still-snoozed task out of the agenda", "folds a snooze ending at 8am…" |
| 7 | Complete through Telegram → ✓ marker remains; reminders stop | ✓ | `tests/flows/tasks.test.ts` "keeps the marker with a ✓…"; `tests/flows/reminders.test.ts` "sends no reminder for a completed task" |
| 8 | Add/remove ✓ in Calendar → completes/reopens | ✓ | `tests/flows/tasks.test.ts` "completes and reopens a task when ✓ is added and removed in Calendar"; owner checked live |
| 9 | Delete one task occurrence in Calendar → only it is cancelled | ✓ | `tests/flows/recurrence.test.ts` "cancels only the occurrence whose marker is deleted in Calendar" |
| 10 | Prior recurring occurrence unfinished → next is independent | ✓ | `tests/flows/recurrence.test.ts` "keeps each occurrence independent…" |
| 11 | Overlapping event created and flagged; task markers excluded | ✓ | `tests/flows/events.test.ts` "flags overlapping events but ignores free time, declined invitations, and task markers" |
| 12 | Invite a saved contact → full email and preview before any notification | ✓ | `tests/flows/conversation.test.ts` "previews every recipient and sends nothing until confirmed…", "asks again if the guest list changed…" |
| 13 | Reply `Move it to 4pm` → correct item; normal confirmation rules | ✓ (fixed grammar) | `tests/flows/conversation.test.ts` follow-ups; `tests/domain/follow-up.test.ts` |
| 14 | Multiple instructions in one message → no partial execution | **Deferred** (structured flows take one instruction per step) | — |
| 15 | `/weekly` or `/monthly` → current period, navigation, no AI | ✓ | `tests/flows/reminders.test.ts` views; `tests/domain/schedule.test.ts` periods |
| 16 | Gemini quota exhausted or unsafe input → structured fallback, nothing sent | ✓ by construction (no Gemini calls exist); **Deferred** for the interpretation path | Every feature is structured |
| 17 | Google temporarily unavailable → pending, retried, confirmed | ✓ | `tests/application/operation-runner.test.ts` "sends one pending notice across retries, then one result", unknown-outcome and crash tests |
| 18 | Three failed sync checks → one outage alert, one recovery | ✓ | `tests/flows/conversation.test.ts` "alerts once after three failed checks, and once on recovery" |
| 19 | Revoked Google access → immediate reconnect alert | ✓ | `tests/flows/google-setup.test.ts` "alerts once when access is revoked…"; owner reauthorized live (Testing mode) |
| 20 | Force poll pressed repeatedly → coalesced, cooldown | ✓ | `tests/jobs/calendar-sync.test.ts` "coalesces Force poll…"; `tests/flows/events.test.ts` /health |
| 21 | Pending edit conflicts with an external edit → user chooses | ✓ | `tests/flows/conversation.test.ts` conflicts; `tests/flows/tasks.test.ts` "reports, without overwriting…" |
| 22 | Duplicate Telegram delivery or write retry → no duplicates | ✓ | `tests/http/webhook.test.ts` "handles a redelivered update only once"; `tests/application/operation-runner.test.ts` lost-response and crash tests |
| 23 | Recovery after missed reminders → one summary; stale event alerts skipped | ✓ | `tests/flows/reminders.test.ts` "after downtime, skips events that already started and summarizes the rest once" |
| 24 | Two users → no shared context, tasks, contacts, tokens, or results | ✓ | Cross-user tests in `tests/jobs/inbox.test.ts`, `tests/application/callbacks.test.ts`, `tests/jobs/calendar-sync.test.ts`, `tests/flows/tasks.test.ts`, `tests/flows/google-setup.test.ts`, `tests/security/token-cipher.test.ts` |

## Spec §13 validation items

| # | Item | Result |
|---|---|---|
| 1 | Gemini feasibility | **Deferred** with stage 9. No data is sent to Gemini. |
| 2 | Shared Cloudflare capacity | No other application uses Workers or D1 in the account. Measured usage: see [capacity](capacity.md). |
| 3 | Calendar deadline display | Owner checked date-only and exact-time markers in Google Calendar (2026-10-03). Markers are free and silent. |
| 4 | OAuth | Narrow scopes; encrypted tokens; account switching confirmed. App remains in Testing (7-day reauthorization) because verification is deferred ([ADR 0002](adr/0002-custom-domain-and-oauth-verification.md)). |
| 5 | Recurrence | Month-end and leap-day rules tested; occurrence identity kept ([ADR 0003](adr/0003-recurring-task-occurrences.md)); single vs. series event changes tested. |
| 6 | Synchronization | Deletion, expired tokens, lost access, conflicts, and echo suppression tested; live sync healthy since 2026-10-03. |
| 7 | Delivery | Deduplication, unknown sends (never resent), coincident reminders (summarized), late-created items tested. Residual risk: a send whose outcome is unknown may be missing (it is never duplicated); `/health` counts these. |
| 8 | Telegram usability | Callback data uses opaque tokens within 64 bytes; stale and cross-user buttons refused; pagination in lists and views; owner used the flows live. |
| 9 | Recovery and retention | Retention purges implemented (inbox/outbox 7 days, operations and reminder log 30 days, links and state on expiry). Restore drill: see [runbook](runbooks/operations.md#restore-drill). List deletion moves tasks to Inbox after confirmation. |
| 10 | Naming and deployment identity | Bot `@oh_my_days_bot`; Worker `oh-my-days` at `ohmydays.xinweichong.com`. |
