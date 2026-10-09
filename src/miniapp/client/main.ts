import { errorText } from "./api";
import { h, replace } from "./dom";
import { back, refresh, type Screen, setRenderer } from "./nav";
import { draw } from "./screens";
import { endSelection } from "./select";
import { telegram } from "./telegram";

/**
 * The Oh My Days Mini App (ADR 0005; experience brief "Telegram Mini App").
 * Every request carries the signed initData; the server decides what this user
 * may see and do, using the chat's own operations.
 */

const tg = telegram();
const root = document.getElementById("app") as HTMLElement;
let lastScreen = "";

async function render(screen: Screen): Promise<void> {
  const name = JSON.stringify(screen);
  if (name !== lastScreen) {
    endSelection();
    replace(root, h("p", { class: "status" }, "Loading…"));
  }
  try {
    const content = await draw(screen);
    replace(root, content);
    if (name !== lastScreen) window.scrollTo(0, 0);
    lastScreen = name;
  } catch (error) {
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
  }
}

/** Tide and overdue fall back to ink if they'd be too faint on this Telegram theme. */
function checkContrast(): void {
  const style = getComputedStyle(document.documentElement);
  const bg = rgb(style.getPropertyValue("--surface"));
  for (const name of ["--tide", "--overdue"]) {
    document.documentElement.style.removeProperty(name);
    const fg = rgb(getComputedStyle(document.documentElement).getPropertyValue(name));
    if (bg && fg && contrast(fg, bg) < 4.5)
      document.documentElement.style.setProperty(name, "var(--ink)");
  }
}

function rgb(value: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (!m?.[1]) return null;
  const n = Number.parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function contrast(a: [number, number, number], b: [number, number, number]): number {
  const lum = (c: [number, number, number]) => {
    const [r, g, bl] = c.map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

function start(): void {
  setRenderer(render);
  if (tg) {
    document.documentElement.dataset.scheme = tg.colorScheme;
    tg.onEvent("themeChanged", () => {
      document.documentElement.dataset.scheme = tg.colorScheme;
      checkContrast();
    });
    tg.BackButton.onClick(back);
    tg.ready();
    tg.expand();
  }
  checkContrast();
  if (!tg?.initData) {
    replace(
      root,
      h(
        "section",
        { class: "banner", role: "alert" },
        h("p", {}, "Open the app with the Open app button in the chat."),
      ),
    );
    return;
  }
  refresh();
}

start();
