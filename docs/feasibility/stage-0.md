# Stage 0 feasibility — status

Date: 2026-09-27. Distinguishes checks done locally from checks that need real
accounts or explicit authorization. Nothing has been provisioned or deployed.

| Item (backend plan stage 0) | Status | Evidence / next step |
|---|---|---|
| Worker + D1 execution model | Local evidence | Batch atomicity, in-batch visibility, guarded no-ops, and foreign keys verified in Miniflare (`tests/storage/d1-semantics.test.ts`). See [ADR 0001](../adr/0001-leases-and-guarded-d1-batches.md). Recheck on remote D1. |
| Worker CPU (10 ms Free limit) | Not measured | Local timings are not representative. Needs a deployed preview Worker and authorization to deploy. |
| Shared-account capacity | Resolved 2026-10-02 | Owner confirmed the other application runs on Oracle Cloud; the Cloudflare account holds only DNS for `xinweichong.com`. No shared Workers/D1/Cron usage. |
| OAuth scopes and ongoing access | Scopes chosen; verification pending | Chosen: `calendar.events`, `calendar.calendarlist.readonly`, `calendar.app.created`, `openid email`. The console refused to publish without verification for these sensitive scopes. Decision ([ADR 0002](../adr/0002-custom-domain-and-oauth-verification.md)): Testing mode now (7-day refresh tokens); verify via `ohmydays.xinweichong.com`. On 2026-10-02 the owner deferred the demo video and verification submission; the bot stays in Testing with weekly reauthorization until then. |
| Deadline marker display | Pending | Needs a dedicated test calendar: all-day and exact-time markers, transparency (free/busy), display in Google Calendar clients. |
| Recurrence round trips | Pending | Needs a dedicated test calendar: instance IDs, exceptions, series edits, month-end and leap-year rules. |
| Gemini input contract | Not started | Deferred to stage 9 per plan; recheck terms, model eligibility, and quota first. |

## Tooling baseline (validated 2026-09-27)

Node 24, npm lockfile, Wrangler 4.141.0, `@cloudflare/vitest-pool-workers` 0.22.0
with Vitest 4.1.11, TypeScript 7.0.2, Biome 2.5.14, `@cloudflare/workers-types`
5.20260926.1. `sharp` is overridden to 0.35.4 to clear an advisory in the test
pool's bundled Miniflare (development-only dependency).

The Wrangler compatibility date is pinned to 2026-08-15, the newest date
supported by the test pool's bundled workerd, so tests and `wrangler dev` run the
same runtime behaviour.
