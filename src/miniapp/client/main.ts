import { errorText } from "./api";
import { h, replace } from "./dom";
import { enterScreen } from "./motion";
import { back, type Mode, refresh, type Screen, setRenderer, syncBackButton } from "./nav";
import { draw } from "./screens";
import { endSelection } from "./select";
import { mainButton, supports, telegram } from "./telegram";
import { closeSheets } from "./ui";

/**
 * The Oh My Days Mini App (ADR 0005; experience brief "Telegram Mini App").
 * Every request carries the signed initData; the server decides what this user
 * may see and do, using the chat's own operations.
 */

const tg = telegram();
const root = document.getElementById("app") as HTMLElement;
let lastScreen = "";
let renderToken = 0;

/** Loading appears only if a screen takes a moment; quick ones never flash it. */
const LOADING_DELAY_MS = 250;

async function render(
  screen: Screen,
  mode: Mode,
  cached?: { node: Node; scroll: number },
): Promise<void> {
  const name = JSON.stringify(screen);
  const fresh = name !== lastScreen;
  const token = ++renderToken;
  if (fresh) {
    endSelection(false);
    closeSheets();
    mainButton(null);
  }
  // Back shows the screen as it was left at once, then refreshes it quietly.
  if (cached && mode === "pop") {
    replace(root, cached.node);
    window.scrollTo(0, cached.scroll);
    enterScreen(root, "pop");
    focusTitle();
    lastScreen = name;
    mode = "refresh";
  }
  const loading =
    fresh && !cached
      ? window.setTimeout(() => {
          if (token !== renderToken) return;
          root.setAttribute("aria-busy", "true");
          if (!root.firstChild || root.querySelector(".status"))
            replace(root, h("p", { class: "status" }, "Loading…"));
          else root.classList.add("is-loading");
        }, LOADING_DELAY_MS)
      : undefined;
  try {
    const content = await draw(screen);
    if (token !== renderToken) return;
    const scroll = window.scrollY;
    replace(root, content);
    if (mode === "refresh") window.scrollTo(0, scroll);
    else {
      window.scrollTo(0, 0);
      enterScreen(root, mode);
      focusTitle();
    }
    lastScreen = name;
  } catch (error) {
    if (token !== renderToken) return;
    lastScreen = "";
    replace(
      root,
      h(
        "section",
        { class: "banner danger", role: "alert" },
        h("p", {}, errorText(error)),
        h("button", { class: "button", type: "button", onclick: refresh }, "Try again"),
      ),
    );
  } finally {
    window.clearTimeout(loading);
    if (token === renderToken) {
      root.removeAttribute("aria-busy");
      root.classList.remove("is-loading");
    }
  }
}

/** Screen readers start at the new screen's title. */
function focusTitle(): void {
  root.querySelector<HTMLElement>("h1")?.focus({ preventScroll: true });
}

// --- Contrast ---------------------------------------------------------------------

type Rgb = [number, number, number];

/** The design system's own colours, used when a Telegram theme colour is too faint. */
const FALLBACK = {
  light: { "--ink-muted": "#51605d", "--danger": "#b42318", "--line-strong": "#7d8e8b" },
  dark: { "--ink-muted": "#9caca9", "--danger": "#ff8a80", "--line-strong": "#7d8e8b" },
} as const;

/**
 * Telegram supplies most colours, and some themes make secondary text, red
 * text, or control outlines too faint on their own backgrounds (iOS light hint
 * grey is 2.8:1 on its grouped background). Each colour is checked against
 * every surface it sits on and replaced by the system's own value, or by ink,
 * when it falls short: 4.5:1 for text, 3:1 for outlines.
 */
function checkContrast(): void {
  const root = document.documentElement;
  for (const name of ["--tide", "--overdue", "--ink-muted", "--danger", "--line-strong"])
    root.style.removeProperty(name);
  const style = getComputedStyle(root);
  const read = (name: string) => rgb(style.getPropertyValue(name));
  const surfaces = ["--surface", "--surface-sunk", "--surface-raised"]
    .map(read)
    .filter((c): c is Rgb => c !== null);
  if (surfaces.length === 0) return;
  const ink = style.getPropertyValue("--ink").trim();
  const scheme = root.dataset.scheme === "dark" ? "dark" : "light";
  const passes = (value: string, min: number) => {
    const c = rgb(value);
    return c !== null && surfaces.every((s) => contrast(c, s) >= min);
  };
  const rules: [string, number][] = [
    ["--tide", 4.5],
    ["--overdue", 4.5],
    ["--ink-muted", 4.5],
    ["--danger", 4.5],
    ["--line-strong", 3],
  ];
  for (const [name, min] of rules) {
    const value = style.getPropertyValue(name).trim();
    if (passes(value, min)) continue;
    const fallback = (FALLBACK[scheme] as Record<string, string>)[name];
    // Outlines try the (already checked) secondary-text grey before ink.
    const muted = getComputedStyle(root).getPropertyValue("--ink-muted").trim();
    const candidates = [fallback, name === "--line-strong" ? muted : undefined];
    const choice = candidates.find((c) => c && passes(c, min)) ?? ink;
    root.style.setProperty(name, choice);
  }
}

function rgb(value: string): Rgb | null {
  const m = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (!m?.[1]) return null;
  const n = Number.parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function contrast(a: Rgb, b: Rgb): number {
  const lum = (c: Rgb) => {
    const [r, g, bl] = c.map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    }) as Rgb;
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

/** Telegram's header and bottom bar take the page's grouped background, so there's no seam. */
function matchShell(): void {
  if (!tg) return;
  if (supports("6.1")) {
    tg.setHeaderColor?.("secondary_bg_color");
    tg.setBackgroundColor?.("secondary_bg_color");
  }
  if (supports("7.10")) tg.setBottomBarColor?.("secondary_bg_color");
}

function start(): void {
  setRenderer(render, () => root.firstChild ?? undefined);
  if (tg) {
    document.documentElement.dataset.scheme = tg.colorScheme;
    tg.onEvent("themeChanged", () => {
      document.documentElement.dataset.scheme = tg.colorScheme;
      checkContrast();
    });
    tg.BackButton.onClick(back);
    tg.ready();
    tg.expand();
    matchShell();
  }
  checkContrast();
  if (!tg?.initData) {
    replace(
      root,
      h(
        "section",
        { class: "banner", role: "alert" },
        h(
          "p",
          {},
          "Telegram didn't pass sign-in data to this page. Open it from an Open app button under a bot message, from /app, or from the bot's profile.",
        ),
      ),
    );
    return;
  }
  syncBackButton();
  refresh();
}

start();
