/**
 * A tiny DOM builder. Text always goes in as text nodes, never as HTML, so
 * titles and other user data can't inject markup.
 */

type Child = Node | string | null | undefined | false;
type Attrs = Record<string, string | boolean | ((event: Event) => void) | undefined>;

export function h(tag: string, attrs: Attrs = {}, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (typeof value === "function") el.addEventListener(key.replace(/^on/, ""), value);
    else if (value === true) el.setAttribute(key, "");
    else el.setAttribute(key, value);
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return el;
}

export function replace(root: HTMLElement, ...children: Child[]): void {
  root.replaceChildren();
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    root.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
}
