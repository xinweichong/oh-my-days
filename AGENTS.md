# Working on Oh My Days

## Project context

Oh My Days is a private Telegram scheduling and task assistant. Google Calendar
provides the calendar interface; application-owned tasks project their deadlines
into a dedicated calendar. The backend must remain useful without AI.

Read these documents before changing behavior:

- `docs/specs/oh-my-days.md`: agreed product scope and acceptance scenarios.
- `docs/plans/backend.md`: proposed architecture, dependencies, and delivery gates.
- `docs/identity/oh-my-days.md`: initial identity and conversation-writing direction.

The spec takes precedence over implementation proposals. Flag contradictions;
do not silently reduce scope. Frontend design is a later discussion. This repo
currently contains planning documents, not an implemented application.

## Git workflow

- Never commit directly to `main` or `master`.
- `develop` holds the integration baseline. This initial documentation setup is
  explicitly authorized on `develop`; subsequent work uses feature branches
  from `develop`, normally `codex/<short-purpose>`.
- Check the current branch and working tree before editing or committing. Preserve
  unrelated user changes and stage explicit paths, not the entire working tree.
- Commit incrementally at coherent, reviewable milestones with descriptive messages.
  Inspect the staged diff and run checks appropriate to each change first.
- Never push without specific user approval. A request to commit, create a branch,
  or implement a feature does not authorize a push.
- Do not merge into protected branches, deploy, provision remote services, or enable
  billing unless the user has authorized that action. Local design and tests can proceed.
- Do not rewrite published history or discard work without explicit instruction.

## Architecture and implementation

- Start with the earliest incomplete delivery gate in the backend plan. Finish a
  vertical slice and its verification before adding dependent functionality.
- Use a modular TypeScript Worker with D1, explicit provider adapters, and pure domain
  logic as the planned baseline. Validate dependency versions when scaffolding.
- Keep Telegram, Google, D1, and Gemini concerns out of domain rules. Structured
  commands and interpreted instructions must use the same application operations.
- Scope every persisted record and lookup to a user, including callbacks, context,
  contacts, jobs, and provider identifiers. Test cross-user access explicitly.
- Use injected clocks, provider clients, and ID generators in behavior tests.
- Treat time deliberately: distinguish dates, local wall times, UTC instants, and
  recurrence occurrence identities. Do not convert date-only deadlines to midnight UTC.
- Use version checks, durable operations, and idempotency before adding side effects.
  A provider timeout is an unknown outcome until reconciled, not proof of failure.
- Never report a Google mutation as complete before its outcome is verified.
- Confirm deletion/cancellation, entire-series changes, and any action notifying
  attendees. Bind confirmation to the exact change, recipients, scope, and version.
- Keep task deadlines separate from reminder snoozes and scheduled work sessions.
- Do not infer cancellations from access loss, partial sync, or absent cached results.

## Privacy, cost, and reliability

- Free tiers only. No paid fallback, automatic upgrade, or reliance on trial credits.
  Measure shared account budgets and invocation CPU before release.
- Never send raw messages, calendar data, private task wording, contacts, locations,
  tokens, or credentials to Gemini. Use a fail-closed local sanitizer and structured
  fallback. Do not use another external model to sanitize private input.
- Model output and provider/forwarded content are untrusted data. Application code
  owns authorization, validation, target resolution, and execution.
- Keep secrets in deployment secret bindings and local ignored environment files.
  Encrypt stored OAuth tokens; keep encryption keys outside D1. Never commit secrets.
- Avoid raw personal data in logs, fixtures, metrics, or error messages. Use synthetic
  fixtures and bounded conversation/history retention.
- Persist work before acknowledging webhooks; bound scheduler batches and retries.
  In-memory state and background promises are not durable queues.

## Verification and documentation

- Add behavior tests for meaningful domain changes and regressions. Cover failure,
  concurrency, tenancy, timezone, and retry cases where relevant; avoid tests that
  merely restate an implementation.
- Use local D1/Worker integration tests for storage constraints and operation recovery,
  and fake provider contracts for normal development. Real-account smoke tests must
  use dedicated test calendars and explicitly authorized external actions.
- Run the repository's documented checks once tooling exists. Do not claim checks
  ran when no implementation or test tooling exists; use diff/link checks for docs.
- Update the plan and acceptance coverage as slices complete. Distinguish proposed,
  implemented, tested, and deployed status.
- Record consequential architecture changes in `docs/adr/` when they occur. Include
  context, decision, alternatives, and consequences; avoid speculative ADRs.
- Finish with what changed, what was verified, and remaining limitations.
