# ADR 0001: Leases and guarded D1 batches for durable work

Status: Accepted (implemented in backend stages 1–2, local verification only)
Date: 2026-09-27

## Context

The backend plan requires durable inbox, outbox, and operation processing with
atomic claims, no duplicate side effects, and recovery after crashes. D1 offers
atomic batches (all statements commit or none do), but no interactive
transactions: a batch cannot read a value and branch on it, and nothing can span
a D1 write and a Google or Telegram call.

## Decision

- **Claims are single-statement compare-and-set updates** that set a random
  `lease_token` and `lease_expires_at`, using `UPDATE … WHERE id = (SELECT …)
  RETURNING`. Claim queries also refuse to start a user's next item while another
  of that user's items holds a live lease, which keeps each user's conversation,
  messages, and changes in order.
- **Effects commit in one batch guarded by the lease.** Every dependent statement
  embeds a `Guard` (a boolean SQL expression, usually `EXISTS (… lease_token = ?)`)
  in its `WHERE` clause, and the batch ends with the statement that releases the
  lease. If the lease was lost, every statement matches nothing and the batch
  is a no-op; the caller detects this from the final statement's change count.
- **A lease that expires mid-attempt means the outcome is unknown.** Reclaimed
  operations are flagged `outcome_unknown`, and handlers read provider state
  before writing. Creates use client-chosen provider IDs; edits compare base,
  current, and intended values; deletes treat "already gone" as done.
- **Button presses consume single-use, user-bound tokens** in the same batch as
  their effect, guarded on this press having consumed the token.

## Alternatives considered

- *Durable Objects for per-user serialization.* Stronger ordering, but adds a
  second storage system and its own free-tier budget; not needed at the planned
  scale.
- *Cloudflare Queues.* Offloads retries but not reconciliation or ordering, and
  adds another shared-account quota to track.
- *SQL tricks that abort a batch on a failed check* (e.g. forcing a JSON or
  constraint error). Atomic, but relies on error-message parsing; guarded
  statements are explicit and testable.

## Consequences

- Repositories take a `Guard` parameter; forgetting it on a dependent statement
  would let effects commit without the lease. Tests cover lease loss for inbox and
  operation commits.
- Telegram sends and provider calls can still happen twice in rare crash windows.
  `sendMessage` with an unknown outcome is never replayed automatically; Calendar
  writes are reconciled rather than repeated.
- `tests/storage/d1-semantics.test.ts` pins the D1 behaviours this relies on in
  local Miniflare. They must be rechecked against remote D1 before release.
