import { complete, reopen, snoozeSheet } from "./actions";
import { h } from "./dom";
import { slideX } from "./motion";
import { onBack, open, type Screen } from "./nav";
import { haptic, telegram, verticalSwipes } from "./telegram";
import type { AppEvent, AppTask } from "./types";

/**
 * Rows grouped on raised surfaces. A task row: check circle (completes),
 * title and metadata (opens the task), a sideways drag that follows the
 * finger to reveal Snooze · More, and a long press that starts multi-select
 * when a selection is offered.
 */

export interface Selection {
  active(): boolean;
  has(task: AppTask): boolean;
  toggle(task: AppTask): void;
  start(task: AppTask): void;
}

export function title(text: string, sub?: string | Node | null, ...extra: Node[]): Node {
  return h(
    "header",
    { class: "screen-title" },
    h(
      "div",
      { class: "title-row" },
      h("h1", { tabindex: "-1" }, text),
      extra.length ? h("div", { class: "title-actions" }, ...extra) : null,
    ),
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

/** The time part of a deadline label ("Due Sat 10 Oct, 5pm" → "5pm"). */
function timeOnly(task: AppTask): string | null {
  if (task.deadline.kind !== "datetime") return null;
  const comma = task.deadline.label.lastIndexOf(", ");
  return comma === -1 ? null : task.deadline.label.slice(comma + 2);
}

function meta(task: AppTask, options: RowOptions): string {
  const parts: string[] = [];
  if (task.overdue) {
    // The age replaces the date: "3 days overdue" says more than "Wed 7 Oct".
  } else if (options.sameDay) {
    const time = timeOnly(task);
    if (time) parts.push(time);
  } else if (task.deadline.kind !== "none") {
    parts.push(task.deadline.label.replace(/^Due /, ""));
  }
  if (options.showList) parts.push(task.list.name);
  if (task.snoozeLabel) parts.push(task.snoozeLabel);
  if (task.closedLabel) parts.push(task.closedLabel);
  return parts.join(" · ");
}

export interface RowOptions {
  showList: boolean;
  /** Rows under a day heading: show only the time, not the date again. */
  sameDay?: boolean;
  tomorrowLabel?: string;
  selection?: Selection;
}

export function taskRow(task: AppTask, options: RowOptions): HTMLElement {
  const { selection } = options;
  const done = task.status === "completed";
  const closed = task.status !== "open";
  const selected = selection?.has(task) ?? false;
  let row: HTMLElement;

  const check = h(
    "button",
    {
      class: `check-target${done ? " checked" : ""}`,
      type: "button",
      "aria-pressed": selection?.active() ? String(selected) : undefined,
      "aria-label": selection?.active()
        ? `${selected ? "Deselect" : "Select"}: ${task.title}`
        : `Mark done: ${task.title}`,
      onclick: () => {
        if (selection?.active()) return selection.toggle(task);
        void complete(task, row);
      },
    },
    h("span", { class: "check", "aria-hidden": "true" }, done || selected ? "✓" : ""),
  );

  const lineText = meta(task, options);
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
    task.overdueLabel || lineText || task.pending
      ? h(
          "span",
          { class: "meta" },
          task.overdueLabel ? h("span", { class: "overdue-text" }, task.overdueLabel) : null,
          task.overdueLabel && lineText ? " · " : null,
          lineText,
          task.pending
            ? h(
                "span",
                { class: "pending" },
                `${lineText || task.overdueLabel ? " · " : ""}Saving to Calendar…`,
              )
            : null,
        )
      : null,
  );

  // Closed tasks show their state (✓ completed, – cancelled) and Reopen or Restore.
  const closedMark = h(
    "span",
    { class: `check${done ? " checked" : " cancelled"}`, "aria-hidden": "true" },
    done ? "✓" : "–",
  );
  const restore = h(
    "button",
    {
      class: "text-button",
      type: "button",
      "aria-label": `${task.status === "cancelled" ? "Restore" : "Reopen"}: ${task.title}`,
      onclick: () => void reopen(task),
    },
    task.status === "cancelled" ? "Restore" : "Reopen",
  );
  const content = h(
    "div",
    { class: "row-content" },
    closed ? closedMark : check,
    main,
    closed ? restore : h("span", { class: "chevron", "aria-hidden": "true" }, "›"),
  );
  // Reached by touch only; the task screen offers the same actions to everyone.
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
            onclick: () => {
              closeSwipes();
              snoozeSheet(task, options.tomorrowLabel);
            },
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
  row = h(
    "li",
    {
      class: `row task${done ? " done" : ""}${closed && !done ? " cancelled" : ""}${selected ? " is-selected" : ""}${selection?.active() ? " in-selection" : ""}`,
      "data-id": task.id,
    },
    content,
    actions,
  );
  if (!closed && actions) gestures(row, content, actions, task, selection);
  return row;
}

// --- Gestures ------------------------------------------------------------------------

const openRows = new Set<HTMLElement>();

/** Closes any row whose actions are showing; returns true if one was open. */
export function closeSwipes(except?: HTMLElement): boolean {
  let closed = false;
  for (const content of [...openRows]) {
    if (content === except) continue;
    openRows.delete(content);
    const x = currentX(content);
    void slideX(content, x, 0);
    closed = true;
  }
  return closed;
}

onBack(() => closeSwipes());

// A tap anywhere else closes an open row, as in iOS lists.
document.addEventListener(
  "pointerdown",
  (event) => {
    const target = event.target as HTMLElement | null;
    const inside = target?.closest(".row.task");
    if (openRows.size && ![...openRows].some((content) => inside?.contains(content))) {
      closeSwipes();
    }
  },
  true,
);

function currentX(el: HTMLElement): number {
  const m = /translateX\((-?[\d.]+)px\)/.exec(el.style.transform);
  return m?.[1] ? Number(m[1]) : 0;
}

/**
 * The row follows a sideways drag and settles open or closed with a spring;
 * vertical movement scrolls as usual. A press held still starts selecting.
 */
function gestures(
  row: HTMLElement,
  content: HTMLElement,
  actions: HTMLElement,
  task: AppTask,
  selection?: Selection,
): void {
  let startX = 0;
  let startY = 0;
  let base = 0;
  let x = 0;
  let lastX = 0;
  let lastT = 0;
  let velocity = 0;
  let state: "idle" | "pending" | "drag" | "scroll" = "idle";
  let press: number | undefined;
  let suppressClick = false;

  const cancelPress = () => {
    window.clearTimeout(press);
    row.classList.remove("pressing");
  };

  content.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    startX = lastX = event.clientX;
    startY = event.clientY;
    lastT = event.timeStamp;
    base = currentX(content);
    x = base;
    velocity = 0;
    state = "pending";
    if (selection && !selection.active()) {
      row.classList.add("pressing");
      press = window.setTimeout(() => {
        row.classList.remove("pressing");
        if (state !== "pending") return;
        state = "idle";
        suppressClick = true;
        haptic("select");
        selection.start(task);
      }, 500);
    }
  });

  content.addEventListener("pointermove", (event) => {
    if (state === "idle" || state === "scroll") return;
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    if (state === "pending") {
      if (Math.abs(dy) > 8 && Math.abs(dy) > Math.abs(dx)) {
        state = "scroll";
        cancelPress();
        return;
      }
      if (Math.abs(dx) < 8 || selection?.active()) return;
      state = "drag";
      cancelPress();
      closeSwipes(content);
      content.setPointerCapture(event.pointerId);
      verticalSwipes(false);
    }
    const width = actions.offsetWidth;
    let next = base + dx;
    // Resistance past either end, like a native list.
    if (next > 0) next = next * 0.2;
    if (next < -width) next = -width + (next + width) * 0.3;
    x = next;
    velocity = (event.clientX - lastX) / Math.max(1, event.timeStamp - lastT);
    lastX = event.clientX;
    lastT = event.timeStamp;
    content.style.transform = `translateX(${x}px)`;
  });

  const finish = () => {
    cancelPress();
    if (state !== "drag") {
      state = "idle";
      return;
    }
    state = "idle";
    suppressClick = true;
    verticalSwipes(true);
    const width = actions.offsetWidth;
    const shouldOpen = velocity < -0.4 || (velocity <= 0.4 && x < -width / 2);
    if (shouldOpen) openRows.add(content);
    else openRows.delete(content);
    void slideX(content, x, shouldOpen ? -width : 0, velocity * 1000);
  };
  content.addEventListener("pointerup", finish);
  content.addEventListener("pointercancel", finish);
  content.addEventListener("contextmenu", (event) => event.preventDefault());

  // A drag or a long press must not also count as a tap; a tap on an open row closes it.
  content.addEventListener(
    "click",
    (event) => {
      if (suppressClick || openRows.has(content)) {
        event.stopPropagation();
        event.preventDefault();
        if (!suppressClick) closeSwipes();
        suppressClick = false;
      }
    },
    true,
  );
}

// --- Events and navigation rows -------------------------------------------------------

export function eventRow(event: AppEvent, options: { timeColumn?: boolean } = {}): HTMLElement {
  // Short times lead in their own column so events read differently from tasks.
  const column = options.timeColumn !== false && event.timeLabel.length <= 12;
  const detail = [column ? null : event.timeLabel, event.calendarName].filter(Boolean).join(" · ");
  return h(
    "li",
    { class: "row event" },
    h(
      "button",
      {
        class: `row-main${column ? " with-time" : ""}`,
        type: "button",
        "aria-label": `${event.timeLabel} ${event.title}, opens Google Calendar`,
        onclick: () => {
          const tg = telegram();
          if (tg) tg.openLink(event.link);
          else window.open(event.link, "_blank", "noopener");
        },
      },
      column ? h("span", { class: "time-col" }, event.timeLabel) : null,
      h(
        "span",
        { class: "row-text" },
        h("span", { class: "headline" }, event.title),
        detail ? h("span", { class: "meta" }, detail) : null,
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
      {
        class: "row-main nav",
        type: "button",
        "aria-label": `${label}, ${detail}`,
        onclick: () => open(screen),
      },
      h("span", { class: "headline" }, label),
      h("span", { class: "count-sm", "aria-hidden": "true" }, detail),
      h("span", { class: "chevron", "aria-hidden": "true" }, "›"),
    ),
  );
}
