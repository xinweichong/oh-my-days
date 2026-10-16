# ADR 0007: Mini App display type, soft depth, and a self-served font

Status: Accepted (owner, 2026-10-16)
Date: 2026-10-16

## Context

After the landing page shipped (ADR 0006), the owner found the Mini App plain by
comparison. The design system kept the product flat and in system type: Figtree,
soft shadows and the tide contour lines were a marketing exception for the
landing page only. The owner compared prototypes of three Home layouts, the
other screens improved within the rules, and four rule relaxations, and chose:

- Figtree for titles and large figures, and soft depth on floating layers;
- tide lines on Home (static) and on a new All clear screen (slow drift);
- the logo in the app: the mark beside Home's heading, the lockup while it loads;
- not to add list colours or icons, and not to move the sun.

The Mini App's content security policy (ADR 0005) is `default-src 'none'`, so
it can't load a font from Google Fonts or from the landing page's hashed assets.

## Decision

- **Design system.** `DESIGN.md` and the identity doc record the relaxed rules:
  Figtree for Mini App titles and large figures; the soft shadow on the next-up
  card, Home tiles, sheets and toasts; tide lines only behind Home's heading and
  on All clear; 16px card corners. Body text, rows, buttons and forms stay system
  UI and flat. The connection pages and privacy policy are unchanged.
- **Font.** `scripts/build-app.mjs` embeds Figtree's Latin variable subset
  (`@fontsource-variable/figtree`, SIL Open Font License, about 20 KB) in the
  generated client module, named by a hash of its bytes. The Worker serves it at
  `/app/figtree-<hash>.woff2` with a one-year immutable cache; any other name is
  404. The page preloads it, declares it with `font-display: swap`, and its CSP
  adds `font-src 'self'`. System UI is the fallback.
- **Logo.** The mark is drawn inline from the approved file's paths (light: tide
  horizon; dark: the reversed white horizon), so it follows Telegram's theme
  without extra requests.
- **Read model.** Home gains what the new tiles show (items behind you today,
  the oldest overdue age, this week's deadline days, overdue counts per list, the
  next event's end) and an `allClear` flag; task sets and task detail gain the
  user's local date and time so the snooze sheet and grouping can name days.
  Nothing new is stored.

## Alternatives

- **Keep the product flat and in system type**, polishing only layout. Lower
  risk, but the owner judged it still wouldn't match the landing page.
- **Load Figtree from Google Fonts.** Needs a third-party origin in the CSP and
  tells Google when the app opens. Rejected.
- **Serve the font from the landing page's static assets.** No Worker CPU, but
  the asset name changes with each landing build and ties the Mini App to it.
- **Inline the font as a data URI in the page.** No extra request, but adds
  about 27 KB to every `/app` response, which is never cached.

## Consequences

- The Worker bundle grows by about 27 KB (the font as base64). The font request
  is one invocation per client per year at most, as it's cached immutably.
- Rows, buttons and forms read exactly as before, so Telegram's native feel and
  Dynamic Type behaviour are unchanged where people read and act.
- The All clear screen is remembered per day in the browser's storage; where
  storage is unavailable it is remembered until the app closes.
- Screenshots in the README and on the landing page show the previous design
  until they are regenerated.
