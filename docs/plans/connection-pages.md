# Google connection pages — implementation plan

Status: Main layout and explicit return to Telegram approved. Implementation pending.

## Scope

Build only the small browser flow for connecting Google Calendar to Oh My Days.
No prototype is required. Calendar selection, default calendar, task calendar, and
timezone setup remain in Telegram. Logo design remains deferred.

Follow the [backend plan](backend.md), [experience brief](../design/experience.md),
and [identity](../identity/oh-my-days.md). Deliver with backend stage 3, after the
OAuth feasibility work and safe-operation foundations. This plan defines interface
behavior; it does not authorize deployment or change the agreed product scope.

## Approved layout and content

Use one narrow, left-aligned column, centered horizontally on wider screens, with
comfortable page margins on mobile. Keep the action and purpose visible without
opening the access details. Use the same shell for every state.

Connection screen, in reading order:

1. **Oh My Days** in text; no placeholder logo.
2. **A little less to keep in your head.**
3. Heading: **Connect Google Calendar**.
4. Description: “View and manage events in the calendars you select. Task deadlines
   appear in ‘Tasks - Oh My Days.’”
5. Primary action: **Connect Google Calendar**.
6. Supporting text: “You'll choose your calendars in Telegram.”
7. Collapsed disclosure: **Access and data details**.

Verified success screen:

1. Same name and tagline.
2. Heading: **✓ Google Calendar connected**.
3. Description: “Choose your calendars and finish setup in Telegram.”
4. Primary action: **Continue in Telegram**.

Wait for the user to press Continue in Telegram; do not automatically redirect,
open the app, or use a countdown. The button targets the configured bot with a safe
continuation reference when needed. Never put OAuth credentials in the Telegram URL.

## Presentation and accessibility

Use a plain light background, dark text, and one restrained accent on primary
buttons. No illustrations, gradients, decorative motion, or custom Telegram styling.
Use readable system typography and conventional controls; exact color and spacing
values are implementation choices within this direction, not another design exercise.

Use a semantic heading, real links/buttons, and a native disclosure where suitable.
Keep keyboard focus visible and reading order logical. Support narrow screens,
text enlargement, long translated/error text, and touch-friendly controls. Check
text/button contrast. Symbols are functional only and never the sole status label.

## Access and data disclosure

Explain what the actual OAuth scopes permit and what the application does with
that access. State that Google may grant broader access than the calendars selected
in the bot; selection limits application behavior, not necessarily OAuth permission.
Explain the dedicated task calendar and how to revoke access. Keep wording aligned
with implemented token handling and data practices. Do not claim end-to-end privacy
or that Google access is restricted to selected calendars unless technically true.

Finalize scope-specific copy after the backend OAuth validation. Keep the initial
summary brief; do not hide a materially different permission behind vague wording.

## State and recovery behavior

The connection and success layouts above are approved. The remaining state copy
below is an implementation proposal consistent with the agreed voice.

| State | Heading and explanation | Action |
|---|---|---|
| Ready | Connect Google Calendar; approved summary | Connect Google Calendar |
| Authorization declined | Connection cancelled. Google Calendar wasn't connected. | Return to Telegram to reconnect |
| Link missing, invalid, or expired | This connection link is no longer valid. Open Telegram to request a new one. | Return to Telegram |
| Provider failure | I couldn't complete the connection. Return to Telegram to try again. | Return to Telegram |
| Different Google account | This account differs from the one already connected. Confirm the account change in Telegram. | Return to Telegram |
| Verified success | ✓ Google Calendar connected; approved description | Continue in Telegram |
| Reauthorization success | ✓ Google Calendar reconnected. Return to Telegram to continue. | Continue in Telegram |

Show an outcome only when known. If a callback was interrupted and the result is
uncertain, verify persisted connection state before choosing success or failure
copy. Do not repeatedly exchange a used authorization code. If a pending outcome
cannot be resolved immediately, explain that the connection could not yet be
confirmed and direct the user to Telegram /health.

Error pages must not display provider stack traces, raw tokens, authorization codes,
or unverified account details. A rejected or expired link cannot initiate a new
account-linking flow without a fresh Telegram-authenticated request. Existing
connections remain intact when a new authorization attempt fails.

If the Telegram button cannot open the app, supporting text may tell the user to
open the existing bot conversation manually. Avoid presenting account setup as
complete merely because Google authorization succeeded.

## Backend integration

Use the Worker's existing HTTP surface; a standalone frontend application is not
needed. Proposed implementation: small server-rendered HTML templates and shared
CSS, with no client framework required. This is a technical proposal, not an
already-selected dependency or scaffold.

1. An allowlisted user initiates linking or reauthorization inside Telegram.
2. The bot produces a short-lived, user-bound connection link.
3. The landing handler validates the link before offering authorization.
4. Connect Google Calendar initiates OAuth with the backend's single-use state and
   configured redirect URI. Google hosts the consent screen.
5. The callback validates state, verifies account identity, stores protected tokens,
   and records the outcome before rendering the appropriate page.
6. Continue in Telegram resumes the server-side setup state. Reauthorization returns
   to the existing conversation without forcing an already completed setup again.

Keep the landing view and authorization initiation distinct: previewing a Telegram
link or refreshing its page must not consume authorization or mutate account state.
Resolve the exact route split within the backend's `/oauth/start` and
`/oauth/callback` contract during implementation. Prevent replay, escape rendered
content, and avoid caching sensitive connection responses or leaking linking values
through logs/referrers. Do not trust user IDs or return URLs supplied by the browser.

## Build order

1. Complete backend OAuth scope/account-linking validation and state contracts.
2. Implement the shared page shell, ready screen, and access disclosure.
3. Wire authorization initiation and the verified callback outcome to those templates.
4. Add success, reauthorization, cancellation, expired-link, account-mismatch, and
   failure states with explicit return actions.
5. Connect the Telegram continuation to the existing setup sequence: calendars,
   default calendar, task calendar, timezone, then summary and first actions.
6. Verify the flow and document its route/configuration requirements in the runbook.

## Acceptance checks

- Mobile and desktop present the same short, readable flow without overflow.
- Keyboard navigation, focus, disclosure, enlarged text, and contrast work correctly.
- There is no automatic redirect from success to Telegram.
- Success requires a verified, persisted connection; setup completion is separate.
- Expired/replayed state, declined consent, wrong-account attempts, provider failures,
  and callback refreshes cannot link the wrong user or overwrite an existing account.
- Calendar selection and timezone controls exist only in Telegram.
- Permission copy matches the implemented scopes and selected-calendar behavior.
- No names, decorative emoji, secrets, or provider diagnostics appear in page copy.
- Use local/fake-provider checks for normal development; a real-account smoke test
  follows the backend plan's authorization and release requirements.
