import { CLIENT_JS } from "./generated/client";
import { FIGTREE_PATH, FIGTREE_WOFF2_BASE64 } from "./generated/font";
import { TIDE_LINES, TIDE_LINES_VIEWBOX } from "./tide-lines";

/**
 * The Mini App document (ADR 0005). Colours come from Telegram's theme
 * parameters with the design system's values as fallbacks; tide and overdue
 * are this system's own (Telegram has neither). Status is always written out.
 */

const STYLE = `
@font-face { font-family: "Figtree"; font-style: normal; font-weight: 300 900; font-display: swap;
  src: url("${FIGTREE_PATH}") format("woff2"); }
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
  --shadow-soft: 0 1px 2px rgb(19 32 30 / 0.06), 0 10px 30px -12px rgb(19 32 30 / 0.22);
  --shadow-overdue: 0 1px 2px rgb(19 32 30 / 0.06), 0 10px 30px -12px rgb(163 74 6 / 0.25);
  --scrim: rgba(0, 0, 0, 0.32);
  --display: "Figtree", system-ui, -apple-system, "Segoe UI", sans-serif;
  --logo-sun: #f2a32c; --logo-horizon: #0b6b62;
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
  --shadow-soft: 0 1px 2px rgb(0 0 0 / 0.4), 0 10px 30px -12px rgb(0 0 0 / 0.6);
  --shadow-overdue: var(--shadow-soft);
  --scrim: rgba(0, 0, 0, 0.5);
  --logo-horizon: #ffffff;
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
[hidden] { display: none !important; }
h1 { font-family: var(--display); font-size: 32px; line-height: 36px; font-weight: 600; letter-spacing: -0.03em;
  margin: 0; text-wrap: balance; overflow-wrap: anywhere; }
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

/* The mark (ADR 0007): the approved paths; the horizon turns white in dark themes */
.mark { display: block; overflow: visible; }
.mark-sun { fill: var(--logo-sun); }
.mark-horizon { fill: none; stroke: var(--logo-horizon); stroke-width: 6; stroke-linecap: round; }
.tide-lines { position: absolute; pointer-events: none; }
.tide-lines path { fill: none; stroke: var(--tide); stroke-width: 1; opacity: 0.12; }

/* Home */
.home-head { position: relative; margin: 4px 0 18px; }
.home-title { position: relative; display: flex; align-items: flex-start; gap: 12px; padding: 0 4px; }
.home-mark { flex: none; width: 50px; height: 27px; margin-top: 10px; }
.home h1, .launch-name { font-size: 38px; line-height: 40px; }
.launch-name { margin: 0; font-family: var(--display); font-weight: 620; letter-spacing: -0.03em; }
.home-sub { margin: 4px 0 0; font-size: 15px; line-height: 20px; color: var(--ink-muted); font-variant-numeric: tabular-nums; }
.next-up { display: flex; flex-direction: column; gap: 14px; width: 100%; margin: 0 0 16px;
  padding: 16px 12px 16px 16px; border: 0; border-radius: 18px; background: var(--surface-raised);
  color: var(--ink); font: inherit; text-align: left; cursor: pointer; box-shadow: var(--shadow-soft); }
.next-up.quiet { display: block; padding: 16px; color: var(--ink-muted); box-shadow: none; cursor: default; }
.next-row { display: flex; align-items: center; gap: 14px; width: 100%; }
.next-time { flex: none; display: flex; flex-direction: column; align-items: center; justify-content: center;
  width: 64px; height: 64px; border-radius: 14px; background: var(--tide-soft); color: var(--tide);
  font-family: var(--display); font-variant-numeric: tabular-nums; }
.next-figure { font-size: 26px; line-height: 28px; font-weight: 700; letter-spacing: -0.02em; }
.next-figure.long { font-size: 20px; line-height: 24px; }
.next-suffix { font-size: 12px; line-height: 14px; font-weight: 600; }
.next-text { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.next-when { font-size: 13px; line-height: 18px; font-weight: 600; color: var(--tide); font-variant-numeric: tabular-nums; }
.next-title { font-family: var(--display); font-size: 22px; line-height: 28px; font-weight: 600;
  letter-spacing: -0.015em; overflow-wrap: anywhere; }
.next-bar { display: block; width: 100%; height: 4px; border-radius: 999px; overflow: hidden;
  background: color-mix(in srgb, var(--tide) 15%, transparent); }
.next-bar-fill { display: block; height: 100%; border-radius: 999px; background: var(--tide); transition: width 600ms ease; }
.tiles { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin-top: 16px; }
.tile { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; min-height: 116px; min-width: 0;
  padding: 14px; border: 0; border-radius: 16px; background: var(--surface-raised); color: var(--ink);
  font: inherit; text-align: left; cursor: pointer; box-shadow: var(--shadow-soft); }
.tile.has-overdue { background: var(--overdue-soft); box-shadow: var(--shadow-overdue); }
.tile.wide { grid-column: 1 / -1; min-height: 0; padding: 16px; gap: 12px; }
.tile-top { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; width: 100%; }
.tile-text { display: flex; flex-direction: column; min-width: 0; }
.tile-title { font-family: var(--display); font-size: 20px; line-height: 24px; font-weight: 600; letter-spacing: -0.015em; }
.tile-text .caption { margin: 0; font-size: 14px; line-height: 20px; }
.tile-label { font-size: 14px; line-height: 20px; font-weight: 600; overflow-wrap: anywhere; }
.count { font-family: var(--display); font-size: 36px; line-height: 40px; font-weight: 600; letter-spacing: -0.03em;
  font-variant-numeric: tabular-nums; }
.tile.wide .count { font-size: 40px; }
.tile > .caption { margin-top: auto; }
.has-overdue .count { color: var(--overdue); }
.segments { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr); gap: 4px; width: 100%; }
.segments.single { display: block; height: 4px; border-radius: 999px; overflow: hidden; background: var(--line); }
.segment { height: 4px; border-radius: 999px; background: var(--line); }
.segment.filled { background: var(--tide); }
.segments.single .segment { height: 100%; }
.week-days { margin-top: auto; display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 2px; width: 100%;
  font-size: 11px; line-height: 14px; color: var(--ink-muted); text-align: center; }
.week-day { display: flex; flex-direction: column; align-items: center; gap: 3px; }
.week-day.today { color: var(--tide); font-weight: 700; }
.dot { width: 5px; height: 5px; border-radius: 999px; background: var(--tide); }
.dot.none { background: transparent; }
.section-title { margin: 24px 4px 10px; font-family: var(--display); font-size: 20px; line-height: 24px;
  font-weight: 600; letter-spacing: -0.015em; }
.home > ul.group { margin-top: 12px; }

/* Launch: the first paint, before the script runs */
.launch { position: relative; }
.launch .home-title { margin: 4px 0 18px; }
.launch-lines { left: calc(-16px - var(--tg-safe-area-inset-left, 0px)); top: -120px; width: 520px; height: 420px; }
.launch-lines g, .clear-lines g { animation: drift 24s linear infinite alternate; }
.launch > :not(.tide-lines) { position: relative; }
.skeleton { display: flex; flex-direction: column; gap: 16px; animation: pulse 1.4s ease-in-out infinite; }
.skel { display: block; border-radius: 16px; background: var(--surface-raised); }
.skel-next { height: 112px; border-radius: 18px; }
.skel-add { height: 54px; border-radius: 999px; }
.skel-tiles { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.skel-wide { grid-column: 1 / -1; height: 92px; }
.skel-tile { height: 116px; }
.skel-list { height: 200px; margin-top: 24px; }
@keyframes pulse { 50% { opacity: 0.55; } }

/* All clear: once a day, when everything today is behind you */
.all-clear { position: relative; display: flex; flex-direction: column;
  min-height: calc(var(--tg-viewport-stable-height, 100vh) - 56px); }
.clear-lines { left: calc(-16px - var(--tg-safe-area-inset-left, 0px)); top: 18%; width: 520px; height: 420px; }
@keyframes drift { to { transform: translateX(-120px); } }
.clear-body { position: relative; flex: 1; display: flex; flex-direction: column; align-items: center;
  justify-content: center; gap: 18px; padding: 48px 16px; text-align: center; }
.clear-mark { width: 88px; height: 48px; }
.all-clear h1 { font-size: 30px; line-height: 34px; letter-spacing: -0.025em; max-width: 13em; }
.clear-text { margin: 0; max-width: 30ch; color: var(--ink-muted); }
.clear-actions { position: relative; display: flex; flex-direction: column; gap: 4px; }

/* Grouped lists */
.group { list-style: none; margin: 0; padding: 0; border-radius: 16px; background: var(--surface-raised);
  overflow: hidden; }
section > .group + .group { margin-top: 12px; }
h2.label.overdue { color: var(--overdue); }
h2.label.today { color: var(--tide); }
.row.series-head { gap: 12px; padding: 12px 12px 10px 16px; }
.series-head .row-text { flex: 1; }
.series-head .headline { font-weight: 600; }
.pill { flex: none; padding: 2px 10px; border-radius: 999px; font-size: 13px; line-height: 20px; font-weight: 600; }
.pill.overdue { background: var(--overdue-soft); color: var(--overdue); }

/* Task detail: the deadline leads, then the facts, then a timeline */
.deadline-hero { padding: 16px 16px 14px; }
.label-inline { display: block; font-size: 12px; line-height: 16px; font-weight: 600; letter-spacing: 0.04em;
  text-transform: uppercase; color: var(--ink-muted); }
.hero-line { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 10px; margin: 4px 0 0;
  font-variant-numeric: tabular-nums; }
.hero-when { font-family: var(--display); font-size: 24px; line-height: 30px; font-weight: 600; letter-spacing: -0.02em; }
.hero-line .overdue-text, .soon { font-size: 15px; font-weight: 600; }
.soon { color: var(--tide); }
.fact-rows { margin: 0; }
.fact { display: flex; gap: 16px; padding: 12px 16px; border-top: 1px solid var(--line); }
.fact dt { flex: none; width: 92px; color: var(--ink-muted); }
.fact dd { flex: 1; min-width: 0; margin: 0; overflow-wrap: anywhere; }
.timeline { padding: 4px 16px; }
.moment { position: relative; display: flex; gap: 14px; padding: 10px 0; font-size: 15px; line-height: 22px; }
.moment-dot { position: relative; z-index: 1; flex: none; width: 10px; height: 10px; margin-top: 6px;
  border: 2px solid var(--line-strong); border-radius: 999px; background: var(--surface-raised); }
.moment.latest .moment-dot { border-color: var(--tide); background: var(--tide); }
.moment:not(:last-child)::before { content: ""; position: absolute; left: 4px; top: 24px; bottom: -8px;
  width: 2px; background: var(--line); }
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
  border: 1px solid var(--line-strong); border-radius: 999px; background: var(--surface-raised); }
.field-with-button:focus-within { outline: 3px solid var(--tide); outline-offset: 2px; }
.field-with-button input { flex: 1; min-width: 0; min-height: 44px; border: 0; background: none; padding: 8px 16px; }
.field-with-button input:focus-visible { outline: none; }
.field-button { flex: none; min-height: 44px; min-width: 64px; padding: 0 18px; border: 0; border-radius: 999px;
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
  padding: 0 16px calc(var(--tg-safe-area-inset-bottom, 0px) + 12px); border-radius: 16px 16px 0 0;
  background: var(--surface); box-shadow: var(--shadow-soft); }
.sheet-handle { position: sticky; top: 0; z-index: 1; margin: 0 -16px; padding: 8px 16px 8px; background: var(--surface);
  touch-action: none; cursor: grab; }
.grabber { display: block; width: 36px; height: 5px; margin: 0 auto 12px; border-radius: 999px; background: var(--line-strong); opacity: 0.6; }
.sheet-title { font-family: var(--display); font-size: 20px; line-height: 24px; font-weight: 600;
  letter-spacing: -0.015em; margin: 0; text-align: center; }

/* Snooze: presets in one tap, or a day and a time */
.snooze-presets { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.snooze-preset { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; min-height: 60px;
  padding: 10px 14px; border: 0; border-radius: 12px; background: var(--surface-sunk); color: var(--ink);
  font: inherit; text-align: left; cursor: pointer; }
.snooze-preset:active, .day-chip:active, .time-chip:active { box-shadow: inset 0 0 0 999px var(--pressed); }
.preset-label { font-weight: 600; line-height: 20px; }
.preset-when { font-size: 13px; line-height: 18px; color: var(--ink-muted); font-variant-numeric: tabular-nums; }
.divider-label { display: flex; align-items: center; gap: 10px; margin: 4px 0 0; font-size: 13px; line-height: 18px;
  color: var(--ink-muted); }
.divider-label::before, .divider-label::after { content: ""; flex: 1; height: 1px; background: var(--line); }
.day-strip { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 4px; }
.day-chip { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px;
  min-height: 58px; padding: 0; border: 0; border-radius: 12px; background: var(--surface-sunk); color: var(--ink);
  font: inherit; cursor: pointer; }
.day-chip[aria-pressed="true"] { background: var(--tide); color: var(--on-tide); }
.day-name { font-size: 11px; line-height: 14px; font-weight: 600; letter-spacing: 0.02em; text-transform: uppercase; }
.day-num { font-size: 18px; line-height: 22px; font-weight: 600; font-variant-numeric: tabular-nums; }
.time-chips { display: flex; flex-wrap: wrap; gap: 8px; }
.time-chip { min-height: 44px; padding: 0 14px; border: 1px solid var(--line); border-radius: 999px;
  background: var(--surface); color: var(--ink); font: inherit; font-variant-numeric: tabular-nums; cursor: pointer; }
.time-chip[aria-pressed="true"] { border-color: var(--tide); background: var(--tide-soft); color: var(--tide); font-weight: 600; }
.time-chip:disabled { opacity: 0.4; cursor: default; }
.time-chip.plain { border-color: transparent; background: none; color: var(--tide); font-weight: 600; }
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

/** The first paint, before the script runs: the lockup where Home's heading will be, and its shape. */
const LAUNCH = `<div class="launch" role="status" aria-label="Oh My Days, opening your day">
<svg class="tide-lines launch-lines" viewBox="${TIDE_LINES_VIEWBOX}" preserveAspectRatio="xMinYMin slice" aria-hidden="true"><g>${TIDE_LINES.map((d) => `<path d="${d}"/>`).join("")}</g></svg>
<div class="home-title"><svg class="mark home-mark" viewBox="7 19 50 27" aria-hidden="true"><path class="mark-sun" d="M17 34a15 15 0 0 1 30 0z"/><path class="mark-horizon" d="M10 43H54"/></svg>
<div><p class="launch-name">Oh My Days</p><p class="home-sub">Opening your day…</p></div></div>
<div class="skeleton" aria-hidden="true"><span class="skel skel-next"></span><span class="skel skel-add"></span>
<span class="skel-tiles"><span class="skel skel-wide"></span><span class="skel skel-tile"></span><span class="skel skel-tile"></span></span>
<span class="skel skel-list"></span></div></div>`;

export function appPage(): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Oh My Days</title>
<link rel="preload" href="${FIGTREE_PATH}" as="font" type="font/woff2" crossorigin>
<script src="https://telegram.org/js/telegram-web-app.js?64"></script>
<style>${STYLE}</style>
</head>
<body>
<main id="app">${LAUNCH}</main>
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
        "default-src 'none'; script-src 'self' https://telegram.org; style-src 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors https://web.telegram.org https://*.telegram.org",
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

let fontBytes: Uint8Array | null = null;

/** The display font (ADR 0007): its path names its content, so it never changes. */
export function appFont(): Response {
  fontBytes ??= Uint8Array.from(atob(FIGTREE_WOFF2_BASE64), (c) => c.charCodeAt(0));
  return new Response(fontBytes, {
    headers: {
      "content-type": "font/woff2",
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    },
  });
}
