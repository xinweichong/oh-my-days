# ADR 0006: Serve a landing page at / as static assets, on a new host

Status: Accepted (owner, 2026-10-15); not yet deployed
Date: 2026-10-15

## Context

The Worker served a minimal homepage at `/` because Google's OAuth verification
requires one (ADR 0002). The owner asked for a proper landing page at
`oh-my-days.xinweichong.com`, built with Motion and components from Kokonut UI,
Origin UI, Animate UI and beUI, in Oh My Days' own design language. Those
libraries are React and Tailwind components. The product's web surfaces so far
are Worker-rendered HTML with no scripts (connection pages, privacy) and a
vanilla TypeScript Mini App (ADR 0005). The owner chose to keep the bot's paths
unchanged, make the new host's root the landing page, and drop the old host
(`ohmydays.xinweichong.com`) at cutover.

## Decision

- Build the landing page from `landing/src` (React 19, Tailwind CSS 4, Motion)
  with `scripts/build-landing.mjs`: esbuild bundles it, renders it once to HTML
  at build time, and writes `landing/dist` with content-hashed assets. The
  browser script only hydrates the prerendered page for its motion; the page
  reads fully without it.
- Serve `landing/dist` with Workers Static Assets from the same Worker
  (`assets` in `wrangler.jsonc`). Assets are matched first, so `/` never
  reaches the Worker; every other path has no asset and reaches the router as
  before. The Worker's `/` route and its homepage are removed. Asset requests
  do not count as Worker invocations and use no CPU budget.
- The landing page carries its own security headers in `landing/dist/_headers`:
  scripts only from the page's own origin, no network requests, no framing.
  The Worker's pages keep their no-script policy.
- Production values stay out of the repository: the build reads the bot
  username and public origin from `wrangler.production.local.json`, else
  `.dev.vars`, else synthetic test values.
- Adapted library components live in `landing/src/vendor/<library>/` with
  their attribution and a note of what changed. Nothing in `landing/` is
  imported by the Worker.
- The page uses a marketing exception to the identity's presentation rules,
  recorded in `docs/identity/oh-my-days.md`.

## Alternatives considered

- *A separate static site (its own Worker or Pages project):* keeps the bot
  Worker untouched, but splits one product over two deployments and two hosts.
  The owner preferred one host with the landing page at its root.
- *Prefixing every bot path (`/bot/...`):* a cleaner split, at the cost of
  re-registering every external URL and changing routing and tests.
- *Hand-written HTML and CSS:* no build step or framework, but the requested
  component libraries are React components.

## Consequences

- `npm run check` and the Wrangler build also build the landing page.
  Tests do not need the build.
- The client bundle is about 140 KB gzipped (React DOM and Motion), loaded as a
  deferred module after the prerendered page has painted.
- The host change needs external updates at cutover, listed in the deploy
  runbook: the Google OAuth redirect URI and authorized domain (and Search
  Console verification), the OAuth consent screen's homepage and privacy links,
  the Telegram webhook, and the Mini App URL in BotFather. Until they are made,
  connecting Google, the webhook and the Mini App stop working.
- Google's homepage requirement is now met by the landing page: it names the
  app and its purpose and links to `/privacy`. The build fails if those links
  disappear.
