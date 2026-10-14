import { h } from "./dom";
import { sheetIn, sheetOut, sheetSettle, toastIn, toastOut } from "./motion";
import { onBack, overlayOpened } from "./nav";

/** Toasts, bottom sheets, and confirmations. */

const TOAST_MS = 5000;
let toastTimer: number | undefined;

/** A short notice at the bottom, optionally with Undo and a bar showing time left. */
export function toast(text: string, undo?: () => void): void {
  for (const old of document.querySelectorAll(".toast")) old.remove();
  window.clearTimeout(toastTimer);
  const dismiss = () => {
    window.clearTimeout(toastTimer);
    void toastOut(el).then(() => el.remove());
  };
  const el = h(
    "div",
    { class: "toast", role: "status" },
    h("span", { class: "toast-text" }, text),
    undo
      ? h(
          "button",
          {
            class: "toast-action",
            type: "button",
            onclick: () => {
              dismiss();
              undo();
            },
          },
          "Undo",
        )
      : null,
    undo ? h("span", { class: "toast-timer", "aria-hidden": "true" }) : null,
  );
  el.style.setProperty("--toast-ms", `${TOAST_MS}ms`);
  document.body.append(el);
  toastIn(el);
  toastTimer = window.setTimeout(dismiss, TOAST_MS);
}

// --- Sheets -----------------------------------------------------------------------

interface OpenSheet {
  close: () => void;
}

const sheets: OpenSheet[] = [];

onBack(() => {
  const top = sheets[sheets.length - 1];
  if (!top) return false;
  top.close();
  return true;
});

document.addEventListener("keydown", (event) => {
  const top = sheets[sheets.length - 1];
  if (top && event.key === "Escape") {
    event.preventDefault();
    top.close();
  }
});

/** Closes every sheet at once (navigation). */
export function closeSheets(): void {
  for (const s of [...sheets].reverse()) s.close();
}

/**
 * A sheet from the bottom edge with a grabber: drag it down, tap outside,
 * press Escape, or use Telegram's Back to close. Focus stays inside while it
 * is open and returns to the control that opened it. Returns `close`.
 */
export function sheet(title: string, ...content: Node[]): () => void {
  closeSheets();
  const opener = document.activeElement as HTMLElement | null;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    sheets.splice(sheets.indexOf(entry), 1);
    overlayOpened(-1);
    backdrop.classList.add("closing");
    void sheetOut(panel, backdrop).then(() => backdrop.remove());
    if (opener?.isConnected) opener.focus({ preventScroll: true });
  };
  const entry: OpenSheet = { close };
  const handle = h(
    "div",
    { class: "sheet-handle" },
    h("span", { class: "grabber", "aria-hidden": "true" }),
    h("h2", { class: "sheet-title", id: "sheet-title" }, title),
  );
  const panel = h(
    "section",
    { class: "sheet", role: "dialog", "aria-modal": "true", "aria-labelledby": "sheet-title" },
    handle,
    h("div", { class: "sheet-body" }, ...content),
    h("button", { class: "button plain wide", type: "button", onclick: close }, "Close"),
  );
  const backdrop = h(
    "div",
    {
      class: "sheet-backdrop",
      onclick: (event) => {
        if (event.target === backdrop) close();
      },
    },
    panel,
  );
  panel.addEventListener("keydown", (event) => trapFocus(panel, event));
  drag(handle, panel, close);
  document.body.append(backdrop);
  sheets.push(entry);
  overlayOpened(1);
  sheetIn(panel, backdrop);
  // Never start on a destructive button: Enter must not confirm by accident.
  const first =
    panel.querySelector<HTMLElement>(
      ".sheet-body input, .sheet-body select, .sheet-body button:not(.danger)",
    ) ?? panel.querySelector<HTMLElement>(".button.plain");
  first?.focus({ preventScroll: true });
  return close;
}

function trapFocus(panel: HTMLElement, event: KeyboardEvent): void {
  if (event.key !== "Tab") return;
  const focusable = [
    ...panel.querySelectorAll<HTMLElement>("button, input, select, [tabindex='0']"),
  ].filter((el) => !el.hasAttribute("disabled"));
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (!first || !last) return;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

/** Dragging the grabber area down far or fast enough closes the sheet. */
function drag(handle: HTMLElement, panel: HTMLElement, close: () => void): void {
  let startY = 0;
  let lastY = 0;
  let lastT = 0;
  let velocity = 0;
  let active = false;
  handle.addEventListener("pointerdown", (event) => {
    active = true;
    startY = lastY = event.clientY;
    lastT = event.timeStamp;
    velocity = 0;
    handle.setPointerCapture(event.pointerId);
  });
  handle.addEventListener("pointermove", (event) => {
    if (!active) return;
    const dy = Math.max(0, event.clientY - startY);
    velocity = (event.clientY - lastY) / Math.max(1, event.timeStamp - lastT);
    lastY = event.clientY;
    lastT = event.timeStamp;
    panel.style.transform = `translateY(${dy}px)`;
  });
  const end = (event: PointerEvent) => {
    if (!active) return;
    active = false;
    const dy = Math.max(0, event.clientY - startY);
    if (dy > 96 || velocity > 0.6) close();
    else if (dy > 0) {
      panel.style.transform = "";
      sheetSettle(panel, dy);
    }
  };
  handle.addEventListener("pointerup", end);
  handle.addEventListener("pointercancel", end);
}

/** Asks before something that can't be undone silently (cancel, series changes). */
export function confirmAction(text: string, label: string, onConfirm: () => void): void {
  const close = sheet(
    label,
    h("p", { class: "sheet-text" }, text),
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
