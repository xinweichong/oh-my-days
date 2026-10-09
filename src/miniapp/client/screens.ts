import {
  cancel,
  complete,
  editSheet,
  quickAdd,
  reopen,
  seriesChange,
  snoozeSheet,
} from "./actions";
import { api } from "./api";
import { h } from "./dom";
import { open, type Screen, swap } from "./nav";
import { eventRow, navRow, savedCopyBanner, section, taskRow, title } from "./rows";
import { selection } from "./select";
import type { Home, Recent, TaskDetail, TaskSet, Today, Week } from "./types";
import { sheet } from "./ui";

/** Each screen fetches its data and returns its content. */
export async function draw(screen: Screen): Promise<Node> {
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

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

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
    quickAdd(),
    h(
      "div",
      { class: "tiles" },
      tile(
        "Today",
        today.events + today.tasks,
        `${plural(today.events, "event")} · ${plural(today.tasks, "task")}`,
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
  const row = (t: Today["due"][number]) =>
    taskRow(t, { showList: true, tomorrowLabel: today.tomorrowLabel });
  return h(
    "div",
    {},
    title("Today", today.label),
    savedCopyBanner(today.live),
    section("Events", ...events.map(eventRow)) ??
      h("p", { class: "empty" }, "Your calendar is clear today."),
    section(`Overdue · ${today.overdue.length}`, ...today.overdue.map(row)),
    section("Due today", ...today.due.map(row)),
    today.openEnded
      ? h("p", { class: "caption" }, `${plural(today.openEnded, "task")} without a deadline`)
      : null,
  );
}

function weekScreen(week: Week): Node {
  const nav = (label: string, start: string) =>
    h(
      "button",
      { class: "button secondary", type: "button", onclick: () => swap({ name: "week", start }) },
      label,
    );
  // Runs of empty days fold into one line.
  const blocks: Node[] = [];
  let empty: string[] = [];
  const flush = () => {
    if (empty.length) {
      const range = empty.length === 1 ? empty[0] : `${empty[0]} – ${empty[empty.length - 1]}`;
      blocks.push(h("p", { class: "empty-days" }, `${range}: nothing`));
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

/** Overdue (grouped per recurring task), No deadline, or one list; long press selects. */
function taskSetScreen(set: TaskSet): Node {
  const select = selection(set.lists, set.tomorrowLabel);
  const options = { showList: set.showList, tomorrowLabel: set.tomorrowLabel, selection: select };
  const bySeries = new Map<string, TaskSet["tasks"]>();
  for (const t of set.tasks) {
    if (t.seriesId) bySeries.set(t.seriesId, [...(bySeries.get(t.seriesId) ?? []), t]);
  }
  const rows: Node[] = [];
  const shown = new Set<string>();
  for (const t of set.tasks) {
    const group = t.seriesId ? (bySeries.get(t.seriesId) ?? []) : [];
    if (t.seriesId && group.length > 1) {
      if (shown.has(t.seriesId)) continue;
      shown.add(t.seriesId);
      rows.push(
        h(
          "li",
          { class: "row group-head" },
          h("span", { class: "meta" }, `${t.title} · ${group.length} overdue`),
        ),
        ...group.map((occurrence) => taskRow(occurrence, options)),
      );
      continue;
    }
    rows.push(taskRow(t, options));
  }
  return h(
    "div",
    {},
    title(set.title, `${set.tasks.length} open`),
    set.listId ? quickAdd(set.listId) : null,
    rows.length ? h("ul", { class: "group" }, ...rows) : h("p", { class: "empty" }, "None"),
    rows.length > 1
      ? h("p", { class: "caption" }, "Press and hold a task to select several.")
      : null,
  );
}

function taskScreen(detail: TaskDetail): Node {
  const t = detail.task;
  const facts: [string, string][] = [
    ["Deadline", t.deadline.label],
    ["List", t.list.name],
  ];
  if (detail.reminder) facts.push(["Reminder", detail.reminder]);
  if (detail.repeat)
    facts.push(["Repeats", `${detail.repeat.label}${detail.repeat.active ? "" : " (stopped)"}`]);
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
  const open = t.status === "open";
  const button = (label: string, onclick: () => void, kind = "secondary") =>
    h("button", { class: `button ${kind}`, type: "button", onclick }, label);
  const repeat = detail.repeat;
  return h(
    "div",
    {},
    title(t.title, status),
    h(
      "dl",
      { class: "facts group" },
      ...facts.flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v)]),
    ),
    h(
      "div",
      { class: "actions" },
      ...(open
        ? [
            button("Done", () => void complete(t), ""),
            button("Snooze", () => snoozeSheet(t, detail.tomorrowLabel)),
            button("Edit", () => editSheet(detail)),
          ]
        : [button(t.status === "cancelled" ? "Restore" : "Reopen", () => void reopen(t), "")]),
    ),
    repeat?.active
      ? section(
          "Series",
          h(
            "li",
            { class: "row actions-row" },
            button("Rename series", () => renameSeriesSheet(repeat, t.title)),
            button("Stop series", () => void seriesChange(repeat, "stop"), "danger"),
          ),
        )
      : null,
    detail.history.length
      ? section("History", ...detail.history.map((line) => h("li", { class: "row plain" }, line)))
      : null,
    open
      ? h(
          "div",
          { class: "actions end" },
          button("Cancel task", () => void cancel(t), "danger"),
        )
      : null,
  );
}

function renameSeriesSheet(repeat: NonNullable<TaskDetail["repeat"]>, current: string): void {
  const input = h("input", {
    type: "text",
    value: current,
    maxlength: "200",
    "aria-label": "New title",
  }) as HTMLInputElement;
  const close = sheet(
    "Rename series",
    h(
      "form",
      {
        class: "stack-form",
        onsubmit: (event) => {
          event.preventDefault();
          close();
          void seriesChange(repeat, "rename", input.value.trim());
        },
      },
      h("label", {}, "Title for every open occurrence", input),
      h("button", { class: "button", type: "submit" }, "Continue"),
    ),
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
