import { CLIENT_JS } from "./generated/client";

/**
 * The Mini App document (ADR 0005). Colours come from Telegram's theme
 * parameters with the design system's values as fallbacks; tide and overdue
 * are this system's own (Telegram has neither). Status is always written out.
 */

const STYLE = `
:root {
  color-scheme: light dark;
  --surface: var(--tg-theme-bg-color, #ffffff);
  --surface-sunk: var(--tg-theme-secondary-bg-color, #f2f5f4);
  --surface-raised: var(--tg-theme-section-bg-color, #ffffff);
  --ink: var(--tg-theme-text-color, #13201e);
  --ink-muted: var(--tg-theme-hint-color, #51605d);
  --line: var(--tg-theme-section-separator-color, #d3dcda);
  --line-strong: #7d8e8b;
  --tide: #0b6b62; --tide-soft: #e2f1ee; --on-tide: #ffffff;
  --overdue: #a34a06; --overdue-soft: #fbeadb;
  --danger: var(--tg-theme-destructive-text-color, #b42318); --danger-soft: #fdecea;
  --pressed: rgba(19, 32, 30, 0.06);
  --toast-shadow: 0 4px 16px rgba(19, 32, 30, 0.16);
  --scrim: rgba(0, 0, 0, 0.32);
}
:root[data-scheme="dark"] {
  --surface: var(--tg-theme-bg-color, #0e1615);
  --surface-sunk: var(--tg-theme-secondary-bg-color, #0a1110);
  --surface-raised: var(--tg-theme-section-bg-color, #162120);
  --ink: var(--tg-theme-text-color, #e6eeec);
  --ink-muted: var(--tg-theme-hint-color, #9caca9);
  --line: var(--tg-theme-section-separator-color, #283634);
  --line-strong: #7d8e8b;
  --tide: #4fbfb1; --tide-soft: #123532; --on-tide: #062421;
  --overdue: #f0a05a; --overdue-soft: #3a2414;
  --danger: var(--tg-theme-destructive-text-color, #ff8a80); --danger-soft: #3b1512;
  --pressed: rgba(255, 255, 255, 0.07);
  --toast-shadow: 0 4px 16px rgba(0, 0, 0, 0.5);
  --scrim: rgba(0, 0, 0, 0.5);
}
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--surface-sunk); color: var(--ink);
  font: 16px/24px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
  -webkit-text-size-adjust: 100%; -webkit-font-smoothing: antialiased; }
body { overflow-x: clip; padding: calc(var(--tg-content-safe-area-inset-top, 0px) + 12px)
  calc(var(--tg-safe-area-inset-right, 0px) + 16px)
  calc(var(--tg-safe-area-inset-bottom, 0px) + 32px)
  calc(var(--tg-safe-area-inset-left, 0px) + 16px); }
body.selecting { padding-bottom: calc(var(--tg-safe-area-inset-bottom, 0px) + 144px); }
::selection { background: var(--tide-soft); color: var(--ink); }
input { caret-color: var(--tide); }
button { -webkit-tap-highlight-color: transparent; touch-action: manipulation; }
main { max-width: 40rem; margin: 0 auto; }
main.is-loading { opacity: 0.6; transition: opacity 120ms linear; }
h1 { font-size: 20px; line-height: 26px; font-weight: 600; margin: 0; text-wrap: balance; overflow-wrap: anywhere; }
h1:focus { outline: none; }
h2.label { font-size: 12px; line-height: 16px; font-weight: 600; letter-spacing: 0.04em;
  text-transform: uppercase; color: var(--ink-muted); margin: 24px 16px 8px; }
.caption { font-size: 13px; line-height: 18px; color: var(--ink-muted); margin: 4px 0 0; }
.caption.hint { margin: 8px 16px 0; }
.footer { margin-top: 24px; text-align: center; }
.status { color: var(--ink-muted); }

/* Screen titles */
.screen-title { margin: 4px 0 16px; }
.title-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 44px; }
.title-actions { display: flex; flex: none; margin-right: -12px; }

/* Home */
.home-head { display: flex; flex-direction: column; gap: 12px; margin: 4px 0 16px; }
.next-up { display: flex; align-items: center; gap: 12px; width: 100%; min-height: 64px; margin: 0;
  padding: 12px 4px 12px 16px; border: 0; border-radius: 12px; background: var(--tide-soft);
  color: var(--ink); font: inherit; text-align: left; cursor: pointer; }
.next-up.quiet { display: block; min-height: 0; padding: 12px 16px; color: var(--ink); }
.next-time { flex: none; min-width: 56px; font-size: 17px; line-height: 22px; font-weight: 600;
  color: var(--tide); font-variant-numeric: tabular-nums; }
.next-up .headline { font-weight: 600; }
.tiles { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 16px; }
.tile { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; min-height: 88px; min-width: 0;
  padding: 12px; border: 0; border-radius: 12px; background: var(--surface-raised); color: var(--ink);
  font: inherit; text-align: left; cursor: pointer; }
.tile.wide { grid-column: 1 / -1; display: grid; grid-template-columns: 1fr auto; grid-template-rows: auto auto;
  align-items: center; column-gap: 12px; min-height: 0; padding: 16px; }
.tile.wide .tile-label { grid-column: 1; grid-row: 1; font-size: 17px; line-height: 22px; }
.tile.wide .caption { grid-column: 1; grid-row: 2; margin: 0; }
.tile.wide .count { grid-column: 2; grid-row: 1 / span 2; }
.tile-label { font-size: 14px; line-height: 20px; font-weight: 600; overflow-wrap: anywhere; }
.count { font-size: 28px; line-height: 32px; font-weight: 600; font-variant-numeric: tabular-nums; margin-top: auto; }
.has-overdue .count { color: var(--overdue); }

/* Grouped lists */
.group { list-style: none; margin: 0; padding: 0; border-radius: 12px; background: var(--surface-raised);
  overflow: hidden; }
section + section .group, .group + .group { margin-top: 0; }
.row { display: flex; align-items: center; min-height: 44px; padding: 0 0 0 16px; position: relative; }
.row + .row::before { content: ""; position: absolute; top: 0; left: 16px; right: 0; z-index: 2;
  border-top: 1px solid var(--line); pointer-events: none; }
.row.task + .row::before, .row + .row.task::before { left: 50px; }
.row.plain { padding: 12px 16px; color: var(--ink-muted); font-size: 14px; line-height: 20px; }
.row-main { flex: 1; display: flex; flex-direction: column; align-items: flex-start; justify-content: center; gap: 2px;
  min-height: 44px; padding: 11px 0; border: 0; background: none; color: inherit; font: inherit;
  text-align: left; cursor: pointer; min-width: 0; }
.row-main.nav { flex-direction: row; align-items: center; gap: 8px; }
.row-main.nav .headline { flex: 1; }
.row-main.with-time { flex-direction: row; align-items: flex-start; gap: 12px; }
.row-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.time-col { flex: none; width: 64px; padding-top: 1px; font-size: 14px; line-height: 20px; color: var(--ink-muted);
  font-variant-numeric: tabular-nums; }
.row:has(> .row-main:active), .row-content:has(.row-main:active), .tile:active { box-shadow: inset 0 0 0 999px var(--pressed); }
.next-up:active { box-shadow: inset 0 0 0 999px var(--pressed); }
.headline { font-size: 17px; line-height: 22px; font-weight: 500; overflow-wrap: anywhere; }
.meta { font-size: 14px; line-height: 20px; color: var(--ink-muted); font-variant-numeric: tabular-nums; }
.overdue-text { color: var(--overdue); font-weight: 600; }
.done .headline, .cancelled .headline { color: var(--ink-muted); }
.cancelled .headline { text-decoration: line-through; text-decoration-color: var(--line-strong); }
.chevron { flex: none; color: var(--ink-muted); padding: 0 16px 0 8px; font-size: 20px; line-height: 20px; }
.count-sm { flex: none; color: var(--ink-muted); font-size: 16px; font-variant-numeric: tabular-nums; }
.pending { color: var(--ink-muted); }

/* Task rows: the content slides over its swipe actions */
.row.task { display: block; padding: 0; overflow: hidden; -webkit-user-select: none; user-select: none;
  -webkit-touch-callout: none; }
.row-content { position: relative; z-index: 1; display: flex; align-items: center; min-height: 44px;
  padding: 0 0 0 16px; background: var(--surface-raised); touch-action: pan-y;
  transition: background-color 120ms linear, scale 300ms ease; will-change: transform; }
.row.task.pressing .row-content { scale: 0.98; transition-delay: 0ms, 150ms; }
.is-selected .row-content { background: var(--tide-soft); }
.in-selection .chevron { visibility: hidden; }
.swipe-actions { position: absolute; top: 0; right: 0; bottom: 0; z-index: 0; display: flex; }
.swipe-button { min-width: 76px; border: 0; background: var(--tide); color: var(--on-tide);
  font: inherit; font-weight: 600; cursor: pointer; }
.swipe-button.more { background: var(--line-strong); color: var(--surface-raised); }

/* Check circle */
.check-target { flex: none; display: inline-flex; align-items: center; justify-content: center;
  width: 44px; height: 44px; margin-left: -10px; margin-right: 0; border: 0; background: none; padding: 0; cursor: pointer; }
.check { flex: none; display: inline-flex; align-items: center; justify-content: center;
  width: 24px; height: 24px; border: 2px solid var(--line-strong); border-radius: 999px;
  color: var(--on-tide); font-size: 14px; line-height: 1; font-weight: 700;
  transition: background-color 120ms ease-out, border-color 120ms ease-out; }
.row > .check { margin: 10px 10px 10px 0; }
.row-content > .check { margin: 10px 10px 10px 0; }
.check.checked, .check-target.checked .check, .is-selected .check-target .check { background: var(--tide); border-color: var(--tide); }
.check.cancelled { border-color: transparent; color: var(--ink-muted); font-weight: 600; font-size: 17px; }
.check-target[aria-busy="true"] { pointer-events: none; }

/* Banners */
.banner { margin: 0 0 16px; padding: 12px 16px; border-radius: 12px; background: var(--surface-raised); }
.banner.danger { background: var(--danger-soft); }
.banner.action { display: flex; align-items: center; gap: 12px; }
.banner.action p { flex: 1; }
.banner p { margin: 0 0 8px; } .banner p:last-child, .banner.action p { margin: 0; }
.empty { color: var(--ink-muted); margin: 8px 16px; }
.empty-days { margin: 16px 16px 0; font-size: 14px; line-height: 20px; color: var(--ink-muted); }
.day.today h2 { color: var(--tide); }
.week-nav { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin: 0 0 8px; }

/* Buttons */
.button { min-height: 44px; padding: 10px 16px; border: 0; border-radius: 12px; background: var(--tide);
  color: var(--on-tide); font: inherit; font-weight: 600; cursor: pointer; transition: opacity 120ms linear; }
.button:active { opacity: 0.7; }
.button:disabled { opacity: 0.4; cursor: default; }
.button.secondary { background: var(--surface-raised); color: var(--ink); box-shadow: inset 0 0 0 1px var(--line); }
.button.plain { background: none; color: var(--tide); }
.button.danger { background: none; color: var(--danger); box-shadow: inset 0 0 0 1px var(--danger); }
.text-button { min-height: 44px; padding: 0 12px; border: 0; background: none; color: var(--tide);
  font: inherit; font-weight: 600; cursor: pointer; }
.text-button:active { opacity: 0.6; }
.wide { display: block; width: 100%; }
.actions { display: grid; grid-template-columns: repeat(auto-fit, minmax(96px, 1fr)); gap: 8px; margin: 16px 0 0; }
.actions:empty { display: none; }
.actions.end { display: block; margin-top: 32px; }
.actions.end .button { width: 100%; }
.actions-row { display: flex; gap: 8px; padding: 8px 16px; flex-wrap: wrap; }
.actions-row .button { flex: 1 1 auto; }
.facts { display: grid; grid-template-columns: max-content 1fr; gap: 12px 16px; padding: 16px; margin: 0; }
.facts dt { color: var(--ink-muted); } .facts dd { margin: 0; overflow-wrap: anywhere; }

/* Forms */
input, select { min-height: 44px; padding: 8px 12px; border: 1px solid var(--line-strong); border-radius: 12px;
  background: var(--surface); color: var(--ink); font: inherit; max-width: 100%; width: 100%; }
input::placeholder { color: var(--ink-muted); opacity: 1; }
label { display: flex; flex-direction: column; gap: 4px; color: var(--ink-muted); font-size: 14px; line-height: 20px; min-width: 0; }
.stack-form { display: flex; flex-direction: column; gap: 8px; margin: 16px 0 0; padding-top: 16px;
  border-top: 1px solid var(--line); }
.stack-form:first-child { margin-top: 0; padding-top: 0; border-top: 0; }
.pick-row, .pick-form { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 8px; }
.pick-form { margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--line); }
.pick-form .button { grid-column: 1 / -1; }
.choice-stack { display: flex; flex-direction: column; gap: 8px; }
.quick-add { margin: 0; }
.field-with-button { display: flex; align-items: center; gap: 4px; padding: 4px 4px 4px 0;
  border: 1px solid var(--line-strong); border-radius: 12px; background: var(--surface-raised); }
.field-with-button:focus-within { outline: 3px solid var(--tide); outline-offset: 2px; }
.field-with-button input { flex: 1; min-width: 0; min-height: 44px; border: 0; background: none; padding: 8px 12px; }
.field-with-button input:focus-visible { outline: none; }
.field-button { flex: none; min-height: 40px; min-width: 64px; padding: 0 16px; border: 0; border-radius: 8px;
  background: var(--tide); color: var(--on-tide); font: inherit; font-weight: 600; cursor: pointer; }
.field-button:disabled { opacity: 0.5; }
.screen-title + .quick-add { margin-bottom: 16px; }
.add-result:not(:empty) { margin-top: 12px; }
.add-result p { margin: 0 0 8px; }

/* Toast */
.toast { position: fixed; left: 16px; right: 16px; bottom: calc(var(--tg-safe-area-inset-bottom, 0px) + 16px);
  display: flex; align-items: center; justify-content: space-between; gap: 12px; max-width: 40rem; margin: 0 auto;
  padding: 8px 8px 8px 16px; border-radius: 12px; background: var(--surface-raised); color: var(--ink);
  box-shadow: var(--toast-shadow); z-index: 3; overflow: hidden; }
body.selecting .toast { bottom: calc(var(--tg-safe-area-inset-bottom, 0px) + 136px); }
.toast-text { padding: 10px 0; }
.toast-action { flex: none; min-height: 44px; padding: 0 12px; border: 0; background: none; color: var(--tide);
  font: inherit; font-weight: 600; cursor: pointer; }
.toast-timer { position: absolute; left: 0; right: 0; bottom: 0; height: 2px; background: var(--tide);
  transform-origin: left; animation: drain var(--toast-ms, 5000ms) linear forwards; }
@keyframes drain { from { transform: scaleX(1); } to { transform: scaleX(0); } }

/* Sheets */
.sheet-backdrop { position: fixed; inset: 0; display: flex; align-items: flex-end; justify-content: center;
  background: var(--scrim); z-index: 4; }
.sheet-backdrop.closing { pointer-events: none; }
.sheet { width: 100%; max-width: 40rem; max-height: 88vh; overflow: auto; overscroll-behavior: contain;
  padding: 0 16px calc(var(--tg-safe-area-inset-bottom, 0px) + 12px); border-radius: 12px 12px 0 0;
  background: var(--surface); }
.sheet-handle { position: sticky; top: 0; z-index: 1; margin: 0 -16px; padding: 8px 16px 8px; background: var(--surface);
  touch-action: none; cursor: grab; }
.grabber { display: block; width: 36px; height: 5px; margin: 0 auto 12px; border-radius: 999px; background: var(--line-strong); opacity: 0.6; }
.sheet-title { font-size: 17px; line-height: 22px; font-weight: 600; margin: 0; text-align: center; }
.sheet-body { display: flex; flex-direction: column; gap: 12px; padding: 8px 0 8px; }
.sheet-body > .caption { margin: 0; text-align: center; }
.sheet-text { margin: 0; }
.sheet > .button.plain { margin-top: 4px; }

/* Multi-select bar */
.select-bar { position: fixed; left: 0; right: 0; bottom: 0; z-index: 2;
  padding: 4px 16px calc(var(--tg-safe-area-inset-bottom, 0px) + 12px); background: var(--surface-raised);
  border-top: 1px solid var(--line); }
.select-head { display: flex; align-items: center; gap: 4px; max-width: 40rem; margin: 0 auto; }
.select-count { flex: 1; font-weight: 600; }
.select-head .text-button:last-child { margin-right: -12px; }
.select-actions { display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; gap: 8px; max-width: 40rem; margin: 4px auto 0; }
.select-actions .button { padding: 10px 8px; }

button:focus-visible, a:focus-visible, input:focus-visible, select:focus-visible { outline: 3px solid var(--tide); outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; scale: none !important; } }
`;

export function appPage(): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Oh My Days</title>
<script src="https://telegram.org/js/telegram-web-app.js?64"></script>
<style>${STYLE}</style>
</head>
<body>
<main id="app"><p class="status">Loading…</p></main>
<script src="/app/app.js" defer></script>
</body>
</html>`;
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      // Telegram Web shows Mini Apps in a frame; nothing else may.
      "content-security-policy":
        "default-src 'none'; script-src 'self' https://telegram.org; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors https://web.telegram.org https://*.telegram.org",
    },
  });
}

export function appScript(): Response {
  return new Response(CLIENT_JS, {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
    },
  });
}
