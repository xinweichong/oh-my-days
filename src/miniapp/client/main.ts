import { h, replace } from "./dom";
import { type TelegramWebApp, telegram } from "./telegram";
import type { AppEvent, AppTask, Home, Recent, TaskDetail, TaskSet, Today, Week } from "./types";

/**
 * The Oh My Days Mini App (ADR 0005; experience brief "Telegram Mini App").
 * Screens are a stack; Telegram's Back button pops it. Every request carries
 * the signed initData; the server decides what this user may see and do.
 */

type Screen =
  | { name: "home" }
  | { name: "today" }
  | { name: "week"; start?: string }
  | { name: "tasks"; view: "overdue" | "no_deadline" | "list"; list?: string }
  | { name: "task"; id: string }
  | { name: "recent" };

const tg: TelegramWebApp | null = telegram();
const root = document.getElementById("app") as HTMLElement;
const stack: Screen[] = [{ name: "home" }];

class ApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly body: unknown = null,
  ) {
    super(code);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/app/api/${path}`, {
      ...init,
      headers: {
        authorization: `tma ${tg?.initData ?? ""}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
    });
  } catch {
    throw new ApiError("network", 0);
  }
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  if (!response.ok) throw new ApiError(body?.error ?? "error", response.status, body);
  return body as T;
}

// --- Navigation ------------------------------------------------------------------

function current(): Screen {
  return stack[stack.length - 1] as Screen;
}

export function open(screen: Screen): void {
  stack.push(screen);
  void render();
}

function back(): void {
  if (stack.length > 1) stack.pop();
  void render();
}

export function refresh(): void {
  void render();
}

async function render(): Promise<void> {
  const screen = current();
  if (stack.length > 1) tg?.BackButton.show();
  else tg?.BackButton.hide();
  replace(root, h("p", { class: "status" }, "Loading…"));
  try {
    replace(root, await draw(screen));
    window.scrollTo(0, 0);
  } catch (error) {
    replace(root, failure(error));
  }
}

async function draw(screen: Screen): Promise<Node> {
  switch (screen.name) {
    case "home":
      return homeScreen(await api<Home>("home"));
    case "today":
      return todayScreen(await api<Today>("today"));
    case "week":
      return weekScreen(await api<Week>(`week${screen.start ? `?start=${screen.start}` : ""}`));
    case "tasks": {
      const query =
        screen.view === "list"
          ? `view=list&list=${encodeURIComponent(screen.list ?? "")}`
          : `view=${screen.view}`;
      return taskSetScreen(await api<TaskSet>(`tasks?${query}`));
    }
    case "task":
      return taskScreen(await api<TaskDetail>(`tasks/${encodeURIComponent(screen.id)}`));
    case "recent":
      return recentScreen(await api<Recent>("recent"));
  }
}

function failure(error: unknown): Node {
  const code = error instanceof ApiError ? error.code : "error";
  const text =
    code === "expired"
      ? "This window has been open for over an hour. Close it and open the app again from the chat."
      : code === "unauthorized"
        ? "Open the app with the Open app button in the chat."
        : code === "setup_incomplete"
          ? "Finish setup in the chat first."
          : code === "network"
            ? "Couldn't reach Oh My Days. Check your connection."
            : "Something went wrong loading this screen.";
  const retry = code === "network" || code === "error";
  return h(
    "section",
    { class: "banner danger", role: "alert" },
    h("p", {}, text),
    retry ? h("button", { class: "button", type: "button", onclick: refresh }, "Try again") : null,
  );
}

// --- Shared pieces -------------------------------------------------------------------

function title(text: string, sub?: string): Node {
  return h(
    "header",
    { class: "screen-title" },
    h("h1", {}, text),
    sub ? h("p", { class: "caption" }, sub) : null,
  );
}

function section(label: string, ...rows: Node[]): Node | null {
  if (rows.length === 0) return null;
  return h("section", {}, h("h2", { class: "label" }, label), h("ul", { class: "group" }, ...rows));
}

function savedCopyBanner(live: boolean): Node | null {
  return live
    ? null
    : h(
        "p",
        { class: "banner", role: "status" },
        "Google Calendar can't be reached. Showing saved copy.",
      );
}

export function taskMeta(task: AppTask, showList: boolean): string[] {
  const parts: string[] = [];
  if (task.deadline.kind !== "none") parts.push(task.deadline.label.replace(/^Due /, ""));
  if (showList) parts.push(task.list.name);
  if (task.snoozeLabel) parts.push(task.snoozeLabel);
  return parts;
}

/** A task row: check circle, title, metadata; the row opens the task. */
export function taskRow(task: AppTask, options: { showList: boolean }): HTMLElement {
  const done = task.status === "completed";
  const meta = taskMeta(task, options.showList);
  return h(
    "li",
    { class: `row task${done ? " done" : ""}`, "data-id": task.id },
    h("span", { class: `check${done ? " checked" : ""}`, "aria-hidden": "true" }, done ? "✓" : ""),
    h(
      "button",
      {
        class: "row-main",
        type: "button",
        onclick: () => open({ name: "task", id: task.id }),
      },
      h("span", { class: "headline" }, task.title),
      h(
        "span",
        { class: "meta" },
        task.overdue ? h("span", { class: "badge overdue" }, "Overdue") : null,
        meta.join(" · "),
        task.pending ? h("span", { class: "pending" }, " · Saving to Calendar…") : null,
        task.closedLabel ? ` · ${task.closedLabel}` : null,
      ),
    ),
    h("span", { class: "chevron", "aria-hidden": "true" }, "›"),
  );
}

function eventRow(event: AppEvent): HTMLElement {
  return h(
    "li",
    { class: "row event" },
    h(
      "button",
      {
        class: "row-main",
        type: "button",
        "aria-label": `${event.timeLabel} ${event.title}, opens Google Calendar`,
        onclick: () => (tg ? tg.openLink(event.link) : window.open(event.link, "_blank")),
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

function navRow(label: string, detail: string, screen: Screen): HTMLElement {
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

// --- Screens ------------------------------------------------------------------------

function homeScreen(home: Home): Node {
  const tile = (label: string, count: number, sub: string, screen: Screen, extra = "") =>
    h(
      "button",
      { class: `tile${extra}`, type: "button", onclick: () => open(screen) },
      h("span", { class: "tile-label" }, label),
      h("span", { class: "count" }, count === 0 ? "None" : String(count)),
      h("span", { class: "caption" }, sub),
    );
  const today = home.tiles.today;
  return h(
    "div",
    {},
    home.reconnect
      ? h(
          "p",
          { class: "banner", role: "status" },
          "Google Calendar needs reconnecting. Send /health in the chat to reconnect.",
        )
      : null,
    h(
      "header",
      { class: "home-head" },
      h("h1", {}, home.label),
      h(
        "p",
        { class: "next-up" },
        home.nextUp ??
          (home.calendarClear ? "Your calendar is clear today." : "Nothing else today."),
      ),
    ),
    h(
      "div",
      { class: "tiles" },
      tile(
        "Today",
        today.events + today.tasks,
        `${today.events} event${today.events === 1 ? "" : "s"} · ${today.tasks} task${today.tasks === 1 ? "" : "s"}`,
        { name: "today" },
      ),
      tile(
        "Overdue",
        home.tiles.overdue,
        home.tiles.overdue ? "Past their deadline" : "Nothing overdue",
        { name: "tasks", view: "overdue" },
        home.tiles.overdue ? " has-overdue" : "",
      ),
      tile("Week", home.tiles.week, "Tasks due this week", { name: "week" }),
      tile("No deadline", home.tiles.noDeadline, "Open tasks", {
        name: "tasks",
        view: "no_deadline",
      }),
    ),
    section(
      "My lists",
      ...home.lists.map((l) =>
        navRow(l.name, l.open ? `${l.open} open` : "None", {
          name: "tasks",
          view: "list",
          list: l.id,
        }),
      ),
    ),
    section(
      "Recent",
      navRow("Completed and cancelled", home.recent ? String(home.recent) : "None", {
        name: "recent",
      }),
    ),
    h("p", { class: "caption footer" }, home.sync),
  );
}

function todayScreen(today: Today): Node {
  const events = [...today.allDay, ...today.timed];
  return h(
    "div",
    {},
    title("Today", today.label),
    savedCopyBanner(today.live),
    section("Events", ...events.map(eventRow)) ??
      h("p", { class: "empty" }, "Your calendar is clear today."),
    section(
      `Overdue · ${today.overdue.length}`,
      ...today.overdue.map((t) => taskRow(t, { showList: true })),
    ),
    section("Due today", ...today.due.map((t) => taskRow(t, { showList: true }))),
    today.openEnded
      ? h(
          "p",
          { class: "caption" },
          `${today.openEnded} task${today.openEnded === 1 ? "" : "s"} without a deadline`,
        )
      : null,
  );
}

function weekScreen(week: Week): Node {
  const nav = (label: string, start: string) =>
    h(
      "button",
      {
        class: "button secondary",
        type: "button",
        onclick: () => {
          stack[stack.length - 1] = { name: "week", start };
          refresh();
        },
      },
      label,
    );
  // Runs of empty days fold into one line.
  const blocks: Node[] = [];
  let empty: string[] = [];
  const flush = () => {
    if (empty.length) {
      blocks.push(
        h(
          "p",
          { class: "empty-days" },
          empty.length === 1
            ? `${empty[0]}: nothing`
            : `${empty[0]} – ${empty[empty.length - 1]}: nothing`,
        ),
      );
      empty = [];
    }
  };
  for (const day of week.days) {
    if (day.events.length + day.tasks.length === 0) {
      empty.push(day.label);
      continue;
    }
    flush();
    blocks.push(
      h(
        "section",
        { class: day.today ? "day today" : "day" },
        h("h2", { class: "label" }, day.today ? `${day.label} · Today` : day.label),
        h(
          "ul",
          { class: "group" },
          ...day.events.map(eventRow),
          ...day.tasks.map((t) => taskRow(t, { showList: true })),
        ),
      ),
    );
  }
  flush();
  return h(
    "div",
    {},
    title(week.label),
    savedCopyBanner(week.live),
    h("div", { class: "week-nav" }, nav("‹ Previous", week.previous), nav("Next ›", week.next)),
    ...blocks,
  );
}

function taskSetScreen(set: TaskSet): Node {
  return h(
    "div",
    {},
    title(set.title, `${set.tasks.length} open`),
    set.tasks.length
      ? h("ul", { class: "group" }, ...set.tasks.map((t) => taskRow(t, { showList: set.showList })))
      : h("p", { class: "empty" }, "None"),
  );
}

function taskScreen(detail: TaskDetail): Node {
  const t = detail.task;
  const facts: [string, string][] = [
    ["Deadline", t.deadline.label],
    ["List", t.list.name],
  ];
  if (detail.reminder) facts.push(["Reminder", detail.reminder]);
  if (detail.repeat) facts.push(["Repeats", detail.repeat.label]);
  if (t.snoozeLabel) facts.push(["Snooze", t.snoozeLabel]);
  if (detail.workTime.length) facts.push(["Work time", detail.workTime.join("; ")]);
  if (t.pending) facts.push(["Calendar", "Saving to Calendar…"]);
  const status =
    t.status === "completed"
      ? "Completed"
      : t.status === "cancelled"
        ? "Cancelled"
        : t.overdue
          ? "Overdue"
          : "Open";
  return h(
    "div",
    {},
    title(t.title, status),
    h(
      "dl",
      { class: "facts group" },
      ...facts.flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v)]),
    ),
    detail.history.length
      ? section("History", ...detail.history.map((line) => h("li", { class: "row plain" }, line)))
      : null,
  );
}

function recentScreen(recent: Recent): Node {
  return h(
    "div",
    {},
    title("Recent", `Completed and cancelled, last ${recent.days} days`),
    recent.tasks.length
      ? h("ul", { class: "group" }, ...recent.tasks.map((t) => taskRow(t, { showList: true })))
      : h("p", { class: "empty" }, "None"),
  );
}

// --- Start -------------------------------------------------------------------

/** Brand colours fall back to ink if they'd be too faint on this Telegram theme. */
function checkContrast(): void {
  const style = getComputedStyle(document.documentElement);
  const bg = parse(style.getPropertyValue("--surface"));
  for (const name of ["--tide", "--overdue"]) {
    const fg = parse(style.getPropertyValue(name));
    if (bg && fg && contrast(fg, bg) < 4.5) {
      document.documentElement.style.setProperty(name, "var(--ink)");
    }
  }
}

function parse(value: string): [number, number, number] | null {
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
  void render();
}

start();
