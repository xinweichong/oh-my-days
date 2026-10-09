import { complete, reopen, snoozeSheet } from "./actions";
import { h } from "./dom";
import { open, type Screen } from "./nav";
import { telegram } from "./telegram";
import type { AppEvent, AppTask } from "./types";

/**
 * Rows grouped on raised surfaces. A task row: check circle (completes),
 * title and metadata (opens the task), swipe left for Snooze · More, and a
 * long press that starts multi-select when a selection is offered.
 */

export interface Selection {
  active(): boolean;
  has(task: AppTask): boolean;
  toggle(task: AppTask): void;
  start(task: AppTask): void;
}

export function title(text: string, sub?: string): Node {
  return h(
    "header",
    { class: "screen-title" },
    h("h1", {}, text),
    sub ? h("p", { class: "caption" }, sub) : null,
  );
}

export function section(label: string, ...rows: Node[]): Node | null {
  if (rows.length === 0) return null;
  return h("section", {}, h("h2", { class: "label" }, label), h("ul", { class: "group" }, ...rows));
}

export function savedCopyBanner(live: boolean): Node | null {
  return live
    ? null
    : h(
        "p",
        { class: "banner", role: "status" },
        "Google Calendar can't be reached. Showing saved copy.",
      );
}

function meta(task: AppTask, showList: boolean): string {
  const parts: string[] = [];
  if (task.deadline.kind !== "none") parts.push(task.deadline.label.replace(/^Due /, ""));
  if (showList) parts.push(task.list.name);
  if (task.snoozeLabel) parts.push(task.snoozeLabel);
  if (task.closedLabel) parts.push(task.closedLabel);
  return parts.join(" · ");
}

export function taskRow(
  task: AppTask,
  options: { showList: boolean; tomorrowLabel?: string; selection?: Selection },
): HTMLElement {
  const { selection } = options;
  const done = task.status === "completed";
  const closed = task.status !== "open";
  const selected = selection?.has(task) ?? false;

  const check = h(
    "button",
    {
      class: `check-target${done ? " checked" : ""}${selected ? " selected" : ""}`,
      type: "button",
      "aria-pressed": selection?.active() ? String(selected) : undefined,
      "aria-label": selection?.active()
        ? `${selected ? "Deselect" : "Select"}: ${task.title}`
        : closed
          ? `${task.status === "cancelled" ? "Restore" : "Reopen"}: ${task.title}`
          : `Mark done: ${task.title}`,
      onclick: () => {
        if (selection?.active()) return selection.toggle(task);
        void (closed ? reopen(task) : complete(task));
      },
    },
    h("span", { class: "check", "aria-hidden": "true" }, done || selected ? "✓" : ""),
  );

  const main = h(
    "button",
    {
      class: "row-main",
      type: "button",
      onclick: () => {
        if (selection?.active()) return selection.toggle(task);
        open({ name: "task", id: task.id });
      },
    },
    h("span", { class: "headline" }, task.title),
    h(
      "span",
      { class: "meta" },
      task.overdue ? h("span", { class: "badge overdue" }, "Overdue") : null,
      meta(task, options.showList),
      task.pending ? h("span", { class: "pending" }, " · Saving to Calendar…") : null,
    ),
  );

  const actions = closed
    ? null
    : h(
        "span",
        { class: "swipe-actions", "aria-hidden": "true" },
        h(
          "button",
          {
            class: "swipe-button",
            type: "button",
            tabindex: "-1",
            onclick: () => snoozeSheet(task, options.tomorrowLabel),
          },
          "Snooze",
        ),
        h(
          "button",
          {
            class: "swipe-button more",
            type: "button",
            tabindex: "-1",
            onclick: () => open({ name: "task", id: task.id }),
          },
          "More",
        ),
      );

  // Closed tasks show their state and an explicit Reopen or Restore.
  const closedMark = h(
    "span",
    { class: `check${done ? " checked" : ""}`, "aria-hidden": "true" },
    done ? "✓" : "",
  );
  const restore = h(
    "button",
    { class: "text-button", type: "button", onclick: () => void reopen(task) },
    task.status === "cancelled" ? "Restore" : "Reopen",
  );
  const row = h(
    "li",
    {
      class: `row task${done ? " done" : ""}${selected ? " is-selected" : ""}`,
      "data-id": task.id,
    },
    closed ? closedMark : check,
    main,
    closed ? restore : h("span", { class: "chevron", "aria-hidden": "true" }, "›"),
    actions,
  );
  if (!closed) gestures(row, task, selection);
  return row;
}

/** Swipe left reveals Snooze · More; a long press starts selecting. */
function gestures(row: HTMLElement, task: AppTask, selection?: Selection): void {
  let startX = 0;
  let startY = 0;
  let press: number | undefined;
  row.addEventListener("pointerdown", (event) => {
    startX = event.clientX;
    startY = event.clientY;
    if (selection && !selection.active()) {
      press = window.setTimeout(() => {
        telegram()?.HapticFeedback?.selectionChanged();
        selection.start(task);
      }, 500);
    }
  });
  const cancelPress = () => window.clearTimeout(press);
  row.addEventListener("pointerup", (event) => {
    cancelPress();
    const dx = event.clientX - startX;
    if (Math.abs(event.clientY - startY) > 30) return;
    if (dx < -50) {
      for (const other of document.querySelectorAll(".row.swiped")) {
        if (other !== row) other.classList.remove("swiped");
      }
      row.classList.add("swiped");
    } else if (dx > 30) {
      row.classList.remove("swiped");
    }
  });
  row.addEventListener("pointermove", (event) => {
    if (Math.abs(event.clientX - startX) > 10 || Math.abs(event.clientY - startY) > 10)
      cancelPress();
  });
  row.addEventListener("pointercancel", cancelPress);
}

export function eventRow(event: AppEvent): HTMLElement {
  return h(
    "li",
    { class: "row event" },
    h(
      "button",
      {
        class: "row-main",
        type: "button",
        "aria-label": `${event.timeLabel} ${event.title}, opens Google Calendar`,
        onclick: () => {
          const tg = telegram();
          if (tg) tg.openLink(event.link);
          else window.open(event.link, "_blank", "noopener");
        },
      },
      h("span", { class: "headline" }, event.title),
      h(
        "span",
        { class: "meta" },
        [event.timeLabel, event.calendarName].filter(Boolean).join(" · "),
      ),
    ),
    h("span", { class: "chevron", "aria-hidden": "true" }, "›"),
  );
}

export function navRow(label: string, detail: string, screen: Screen): HTMLElement {
  return h(
    "li",
    { class: "row" },
    h(
      "button",
      { class: "row-main", type: "button", onclick: () => open(screen) },
      h("span", { class: "headline" }, label),
    ),
    h("span", { class: "count-sm" }, detail),
    h("span", { class: "chevron", "aria-hidden": "true" }, "›"),
  );
}
