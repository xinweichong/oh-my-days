import { telegram } from "./telegram";

/** A stack of screens; Telegram's Back button pops it. */

export type Screen =
  | { name: "home" }
  | { name: "today" }
  | { name: "week"; start?: string }
  | { name: "tasks"; view: "overdue" | "no_deadline" | "list"; list?: string }
  | { name: "task"; id: string }
  | { name: "recent" };

const stack: Screen[] = [{ name: "home" }];
let renderer: (screen: Screen) => Promise<void> = async () => {};

export function setRenderer(render: (screen: Screen) => Promise<void>): void {
  renderer = render;
}

export function current(): Screen {
  return stack[stack.length - 1] as Screen;
}

export function depth(): number {
  return stack.length;
}

export function open(screen: Screen): void {
  stack.push(screen);
  void show();
}

export function back(): void {
  if (stack.length > 1) stack.pop();
  void show();
}

/** Replaces the current screen (e.g. Week's previous and next). */
export function swap(screen: Screen): void {
  stack[stack.length - 1] = screen;
  void show();
}

export function refresh(): void {
  void show();
}

async function show(): Promise<void> {
  const tg = telegram();
  if (stack.length > 1) tg?.BackButton.show();
  else tg?.BackButton.hide();
  await renderer(current());
}
