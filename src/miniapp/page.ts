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
  --toast-shadow: 0 4px 16px rgba(19, 32, 30, 0.16);
}
:root[data-scheme="dark"] {
  --surface: var(--tg-theme-bg-color, #0e1615);
  --surface-sunk: var(--tg-theme-secondary-bg-color, #0a1110);
  --surface-raised: var(--tg-theme-section-bg-color, #162120);
  --ink: var(--tg-theme-text-color, #e6eeec);
  --ink-muted: var(--tg-theme-hint-color, #9caca9);
  --line: var(--tg-theme-section-separator-color, #283634);
  --line-strong: #5d6f6c;
  --tide: #4fbfb1; --tide-soft: #123532; --on-tide: #062421;
  --overdue: #f0a05a; --overdue-soft: #3a2414;
  --danger: var(--tg-theme-destructive-text-color, #ff8a80); --danger-soft: #3b1512;
  --toast-shadow: 0 4px 16px rgba(0, 0, 0, 0.5);
}
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--surface-sunk); color: var(--ink);
  font: 16px/24px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif; }
body { padding: calc(var(--tg-content-safe-area-inset-top, 0px) + 12px)
  calc(var(--tg-safe-area-inset-right, 0px) + 16px)
  calc(var(--tg-safe-area-inset-bottom, 0px) + 24px)
  calc(var(--tg-safe-area-inset-left, 0px) + 16px); }
main { max-width: 40rem; margin: 0 auto; }
h1 { font-size: 20px; line-height: 26px; font-weight: 600; margin: 0; text-wrap: balance; }
h2.label { font-size: 12px; line-height: 16px; font-weight: 600; letter-spacing: 0.04em;
  text-transform: uppercase; color: var(--ink-muted); margin: 24px 0 8px; }
.caption { font-size: 13px; line-height: 18px; color: var(--ink-muted); margin: 4px 0 0; }
.footer { margin-top: 24px; text-align: center; }
.screen-title { margin-bottom: 8px; }
.home-head { display: flex; flex-direction: column; gap: 8px; margin-bottom: 16px; }
.next-up { margin: 0; padding: 12px 16px; border-radius: 12px; background: var(--tide-soft); }
.tiles { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.tile { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; min-height: 44px;
  padding: 16px; border: 0; border-radius: 12px; background: var(--surface-raised); color: var(--ink);
  font: inherit; text-align: left; cursor: pointer; }
.tile-label { font-weight: 600; }
.count { font-size: 28px; line-height: 32px; font-weight: 600; font-variant-numeric: tabular-nums; }
.has-overdue .count { color: var(--overdue); }
.group { list-style: none; margin: 0; padding: 0; border-radius: 12px; background: var(--surface-raised);
  overflow: hidden; }
.row { display: flex; align-items: center; min-height: 44px; padding: 0 4px 0 16px; position: relative; }
.row + .row::before { content: ""; position: absolute; top: 0; left: 16px; right: 0;
  border-top: 1px solid var(--line); }
.row.plain { padding: 12px 16px; color: var(--ink-muted); font-size: 14px; }
.row-main { flex: 1; display: flex; flex-direction: column; align-items: flex-start; gap: 2px;
  min-height: 44px; padding: 12px 0; border: 0; background: none; color: inherit; font: inherit;
  text-align: left; cursor: pointer; min-width: 0; }
.headline { font-size: 17px; line-height: 22px; font-weight: 500; overflow-wrap: anywhere; }
.meta { font-size: 14px; line-height: 20px; color: var(--ink-muted); }
.done .headline { color: var(--ink-muted); }
.chevron { color: var(--ink-muted); padding: 0 12px; }
.count-sm { color: var(--ink-muted); font-size: 14px; }
.check { flex: none; display: inline-flex; align-items: center; justify-content: center;
  width: 24px; height: 24px; margin: 10px 12px 10px 0; border: 2px solid var(--line-strong);
  border-radius: 999px; color: var(--on-tide); font-size: 14px; font-weight: 700; }
.check.checked { background: var(--tide); border-color: var(--tide); }
.badge { display: inline-block; padding: 0 8px; margin-right: 6px; border-radius: 999px;
  font-size: 12px; font-weight: 600; }
.badge.overdue { color: var(--overdue); background: var(--overdue-soft); }
.pending { color: var(--ink-muted); }
.banner { margin: 0 0 16px; padding: 12px 16px; border-radius: 12px; background: var(--surface-raised); }
.banner.danger { background: var(--danger-soft); }
.banner p { margin: 0 0 8px; } .banner p:last-child { margin: 0; }
.empty, .empty-days, .status { color: var(--ink-muted); }
.empty-days { margin: 12px 0 0; font-size: 14px; }
.day.today h2 { color: var(--tide); }
.week-nav { display: flex; justify-content: space-between; gap: 12px; margin: 12px 0; }
.button { min-height: 44px; padding: 10px 16px; border: 0; border-radius: 6px; background: var(--tide);
  color: var(--on-tide); font: inherit; font-weight: 600; cursor: pointer; }
.button.secondary { background: var(--surface-raised); color: var(--ink); border: 1px solid var(--line-strong); }
.button.danger { background: none; color: var(--danger); border: 1px solid var(--danger); }
.facts { display: grid; grid-template-columns: max-content 1fr; gap: 8px 16px; padding: 16px; margin: 16px 0 0; }
.facts dt { color: var(--ink-muted); } .facts dd { margin: 0; overflow-wrap: anywhere; }
.check-target { flex: none; display: inline-flex; align-items: center; justify-content: center;
  width: 44px; height: 44px; margin-left: -10px; border: 0; background: none; padding: 0; cursor: pointer; }
.check-target .check { margin: 0; }
.check-target.checked .check, .is-selected .check-target .check { background: var(--tide); border-color: var(--tide); }
.is-selected { background: var(--tide-soft); }
.text-button { min-height: 44px; padding: 0 12px; border: 0; background: none; color: var(--tide);
  font: inherit; font-weight: 600; cursor: pointer; }
.row.task { overflow: hidden; }
.swipe-actions { position: absolute; top: 0; right: 0; bottom: 0; display: flex;
  transform: translateX(100%); transition: transform 160ms ease; }
.row.swiped .swipe-actions { transform: none; }
.swipe-button { min-width: 72px; border: 0; background: var(--tide); color: var(--on-tide);
  font: inherit; font-weight: 600; cursor: pointer; }
.swipe-button.more { background: var(--surface-sunk); color: var(--ink); }
.row.group-head { min-height: 32px; padding-top: 8px; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 16px 0 0; }
.actions .button { flex: 1 1 auto; }
.actions.end { margin-top: 24px; }
.actions-row { gap: 8px; padding: 8px 16px; flex-wrap: wrap; }
.wide { display: block; width: 100%; margin-top: 8px; }
input, select { min-height: 44px; padding: 8px 12px; border: 1px solid var(--line-strong); border-radius: 6px;
  background: var(--surface); color: var(--ink); font: inherit; max-width: 100%; }
label { display: flex; flex-direction: column; gap: 4px; color: var(--ink-muted); font-size: 14px; }
.stack-form { display: flex; flex-direction: column; gap: 8px; margin: 12px 0; padding-top: 12px;
  border-top: 1px solid var(--line); }
.inline-form { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.quick-add { margin: 0 0 16px; }
.quick-add-row { display: flex; gap: 8px; } .quick-add-row input { flex: 1; min-width: 0; }
.add-result p { margin: 8px 0 0; }
.toast { position: fixed; left: 16px; right: 16px; bottom: calc(var(--tg-safe-area-inset-bottom, 0px) + 16px);
  display: flex; align-items: center; justify-content: space-between; gap: 12px; max-width: 40rem; margin: 0 auto;
  padding: 8px 8px 8px 16px; border-radius: 12px; background: var(--surface-raised); color: var(--ink);
  box-shadow: var(--toast-shadow); animation: up 160ms ease; z-index: 3; }
.toast-action { min-height: 44px; padding: 0 12px; border: 0; background: none; color: var(--tide);
  font: inherit; font-weight: 600; cursor: pointer; }
@keyframes up { from { transform: translateY(8px); opacity: 0; } to { transform: none; opacity: 1; } }
.sheet-backdrop { position: fixed; inset: 0; display: flex; align-items: flex-end; justify-content: center;
  background: rgba(0, 0, 0, 0.35); z-index: 4; }
.sheet { width: 100%; max-width: 40rem; max-height: 85vh; overflow: auto; padding: 16px 16px
  calc(var(--tg-safe-area-inset-bottom, 0px) + 16px); border-radius: 12px 12px 0 0; background: var(--surface); }
.sheet-title { font-size: 17px; margin: 0 0 8px; }
.select-bar { position: fixed; left: 0; right: 0; bottom: 0; display: flex; flex-wrap: wrap; align-items: center;
  gap: 8px; padding: 8px 16px calc(var(--tg-safe-area-inset-bottom, 0px) + 8px); background: var(--surface-raised);
  border-top: 1px solid var(--line); z-index: 2; }
.select-count { flex: 1 0 100%; font-weight: 600; }
button:focus-visible, a:focus-visible, input:focus-visible, select:focus-visible { outline: 3px solid var(--tide); outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }
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
<main id="app" aria-live="polite"><p class="status">Loading…</p></main>
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
