import type { Direction } from "./motion";
import { telegram } from "./telegram";

/**
 * A stack of screens; Telegram's Back button pops it. Going back shows the
 * previous screen as it was left (then refreshes it quietly), and first
 * closes whatever is on top of the screen: a sheet, an open swipe, a selection.
 */

export type Screen =
  | { name: "home" }
  | { name: "today" }
  | { name: "week"; start?: string }
  | { name: "tasks"; view: "overdue" | "no_deadline" | "list"; list?: string }
  | { name: "task"; id: string }
  | { name: "recent" }
  /** Shown once a day when everything today is behind you (ADR 0007). */
  | { name: "clear"; total: number };

export type Mode = Direction | "refresh";

interface Entry {
  screen: Screen;
  /** The screen's content when it was left, shown at once on Back. */
  node?: Node | undefined;
  scroll: number;
}

type Renderer = (
  screen: Screen,
  mode: Mode,
  cached?: { node: Node; scroll: number },
) => Promise<void>;

const stack: Entry[] = [{ screen: { name: "home" }, scroll: 0 }];
let renderer: Renderer = async () => {};
let snapshot: () => Node | undefined = () => undefined;
const overlays: (() => boolean)[] = [];

export function setRenderer(render: Renderer, current: () => Node | undefined): void {
  renderer = render;
  snapshot = current;
}

/** Registers something Back closes before leaving the screen; returns true if it closed. */
export function onBack(close: () => boolean): void {
  overlays.push(close);
}

export function current(): Screen {
  return (stack[stack.length - 1] as Entry).screen;
}

export function depth(): number {
  return stack.length;
}

export function open(screen: Screen): void {
  const top = stack[stack.length - 1] as Entry;
  top.node = snapshot();
  top.scroll = window.scrollY;
  stack.push({ screen, scroll: 0 });
  void show("push");
}

export function back(): void {
  for (const close of overlays) {
    if (close()) {
      syncBackButton();
      return;
    }
  }
  if (stack.length <= 1) return;
  stack.pop();
  const top = stack[stack.length - 1] as Entry;
  const cached = top.node ? { node: top.node, scroll: top.scroll } : undefined;
  top.node = undefined;
  void show("pop", cached);
}

/** Replaces the current screen (e.g. Week's previous and next). */
export function swap(screen: Screen): void {
  (stack[stack.length - 1] as Entry).screen = screen;
  void show("swap");
}

/** Redraws the current screen in place, keeping the scroll position. */
export function refresh(): void {
  void show("refresh");
}

let overlayCount = 0;

/** Sheets report themselves so Back is offered even on Home. */
export function overlayOpened(delta: 1 | -1): void {
  overlayCount = Math.max(0, overlayCount + delta);
  syncBackButton();
}

export function syncBackButton(): void {
  const tg = telegram();
  if (stack.length > 1 || overlayCount > 0) tg?.BackButton.show();
  else tg?.BackButton.hide();
}

async function show(mode: Mode, cached?: { node: Node; scroll: number }): Promise<void> {
  syncBackButton();
  await renderer(current(), mode, cached);
}
