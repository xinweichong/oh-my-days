import { h } from "./dom";

/** Toasts, bottom sheets, and confirmations. */

let toastTimer: number | undefined;

/** A short notice at the bottom, optionally with Undo. */
export function toast(text: string, undo?: () => void): void {
  document.querySelector(".toast")?.remove();
  window.clearTimeout(toastTimer);
  const el = h(
    "div",
    { class: "toast", role: "status" },
    h("span", {}, text),
    undo
      ? h(
          "button",
          {
            class: "toast-action",
            type: "button",
            onclick: () => {
              el.remove();
              undo();
            },
          },
          "Undo",
        )
      : null,
  );
  document.body.append(el);
  toastTimer = window.setTimeout(() => el.remove(), 5000);
}

/** A sheet over the screen; returns a function that closes it. */
export function sheet(title: string, ...content: Node[]): () => void {
  document.querySelector(".sheet-backdrop")?.remove();
  const close = () => backdrop.remove();
  const backdrop = h(
    "div",
    {
      class: "sheet-backdrop",
      onclick: (event) => {
        if (event.target === backdrop) close();
      },
    },
    h(
      "section",
      { class: "sheet", role: "dialog", "aria-modal": "true", "aria-label": title },
      h("h2", { class: "sheet-title" }, title),
      ...content,
      h("button", { class: "button secondary wide", type: "button", onclick: close }, "Close"),
    ),
  );
  document.body.append(backdrop);
  (backdrop.querySelector("button, input, select") as HTMLElement | null)?.focus();
  return close;
}

/** Asks before something that can't be undone silently (cancel, series changes). */
export function confirmAction(text: string, label: string, onConfirm: () => void): void {
  const close = sheet(
    label,
    h("p", {}, text),
    h(
      "button",
      {
        class: "button danger wide",
        type: "button",
        onclick: () => {
          close();
          onConfirm();
        },
      },
      label,
    ),
  );
}
