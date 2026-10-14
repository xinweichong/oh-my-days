import {
  cancel,
  complete,
  editSheet,
  quickAdd,
  reconnect,
  reopen,
  seriesChange,
  snoozeAllSheet,
  snoozeSheet,
} from "./actions";
import { api } from "./api";
import { h } from "./dom";
import { open, type Screen, swap } from "./nav";
import { eventRow, navRow, savedCopyBanner, section, taskRow, title } from "./rows";
import { selection } from "./select";
import { mainButton, telegram } from "./telegram";
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
      return taskSetScreen(await api<TaskSet>(`tasks?${query}`), screen.view);
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

/** Next up leads Home: the time first, then what it is and how soon. */
function nextUpCard(home: Home): Node {
  const next = home.next;
  if (!next) {
    return h(
      "p",
      { class: "next-up quiet" },
      home.calendarClear ? "Your calendar is clear today." : "Nothing else today.",
    );
  }
  const go = () => {
    if (next.taskId) return open({ name: "task", id: next.taskId });
    if (!next.link) return;
    const tg = telegram();
    if (tg) tg.openLink(next.link);
    else window.open(next.link, "_blank", "noopener");
  };
  const when = next.kind === "task" ? "Deadline" : next.when;
  return h(
    "button",
    {
      class: "next-up",
      type: "button",
      "aria-label": `Next up: ${next.time} ${next.title}, ${when}`,
      onclick: go,
    },
    h("span", { class: "next-time" }, next.time),
    h(
      "span",
      { class: "row-text" },
      h("span", { class: "headline" }, next.title),
      h("span", { class: "meta" }, when),
    ),
    h("span", { class: "chevron", "aria-hidden": "true" }, "›"),
  );
}

function homeScreen(home: Home): Node {
  const tile = (label: string, count: number, sub: string | null, screen: Screen, extra = "") =>
    h(
      "button",
      {
        class: `tile${extra}`,
        type: "button",
        "aria-label": `${label}: ${count === 0 ? "none" : count}${sub ? `, ${sub}` : ""}`,
        onclick: () => open(screen),
      },
      h("span", { class: "tile-label" }, label),
      h("span", { class: "count" }, count === 0 ? "None" : String(count)),
      sub ? h("span", { class: "caption" }, sub) : null,
    );
  const today = home.tiles.today;
  return h(
    "div",
    {},
    home.reconnect
      ? h(
          "section",
          { class: "banner action", role: "status" },
          h("p", {}, "Google Calendar needs reconnecting. Events may be out of date."),
          h(
            "button",
            { class: "button", type: "button", onclick: () => void reconnect() },
            "Reconnect",
          ),
        )
      : null,
    h(
      "header",
      { class: "home-head" },
      h("h1", { tabindex: "-1" }, home.heading),
      nextUpCard(home),
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
        " wide",
      ),
      tile(
        "Overdue",
        home.tiles.overdue,
        null,
        { name: "tasks", view: "overdue" },
        home.tiles.overdue ? " has-overdue" : "",
      ),
      tile("This week", home.tiles.week, null, { name: "week" }),
      tile("No deadline", home.tiles.noDeadline, null, {
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
    home.reconnect ? null : h("p", { class: "caption footer" }, home.sync),
  );
}

function todayScreen(today: Today): Node {
  const events = [...today.allDay, ...today.timed];
  const row = (t: Today["due"][number]) =>
    taskRow(t, { showList: true, sameDay: true, tomorrowLabel: today.tomorrowLabel });
  return h(
    "div",
    {},
    title("Today", today.label),
    savedCopyBanner(today.live),
    section("Events", ...events.map((e) => eventRow(e))) ??
      h("p", { class: "empty" }, "Your calendar is clear today."),
    section(`Overdue · ${today.overdue.length}`, ...today.overdue.map(row)),
    section("Due today", ...today.due.map(row)),
    today.openEnded
      ? h("p", { class: "caption" }, `${plural(today.openEnded, "task")} without a deadline`)
      : null,
  );
}

function weekScreen(week: Week): Node {
  const nav = (label: string, start: string, aria: string) =>
    h(
      "button",
      {
        class: "button secondary",
        type: "button",
        "aria-label": aria,
        onclick: () => swap({ name: "week", start }),
      },
      label,
    );
  const isThisWeek = week.days.some((d) => d.today);
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
          ...day.events.map((e) => eventRow(e)),
          ...day.tasks.map((t) => taskRow(t, { showList: true, sameDay: true })),
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
    h(
      "div",
      { class: "week-nav" },
      nav("‹ Previous", week.previous, "Previous week"),
      isThisWeek
        ? null
        : h(
            "button",
            { class: "button plain", type: "button", onclick: () => swap({ name: "week" }) },
            "This week",
          ),
      nav("Next ›", week.next, "Next week"),
    ),
    ...blocks,
  );
}

/** Overdue (grouped per recurring task), No deadline, or one list. */
function taskSetScreen(set: TaskSet, view: "overdue" | "no_deadline" | "list"): Node {
  const select = selection(set.tasks, set.lists, set.tomorrowLabel);
  const options = { showList: set.showList, tomorrowLabel: set.tomorrowLabel, selection: select };
  const bySeries = new Map<string, TaskSet["tasks"]>();
  for (const t of set.tasks) {
    if (t.seriesId) bySeries.set(t.seriesId, [...(bySeries.get(t.seriesId) ?? []), t]);
  }
  // Recurring occurrences gather in their own group; everything else shares one.
  const groups: Node[] = [];
  const loose: Node[] = [];
  const shown = new Set<string>();
  for (const t of set.tasks) {
    const series = t.seriesId ? (bySeries.get(t.seriesId) ?? []) : [];
    if (t.seriesId && series.length > 1) {
      if (shown.has(t.seriesId)) continue;
      shown.add(t.seriesId);
      groups.push(
        h(
          "section",
          {},
          h(
            "h2",
            { class: "label" },
            `${t.title} · ${series.length} ${view === "overdue" ? "overdue" : "open"}`,
          ),
          h("ul", { class: "group" }, ...series.map((o) => taskRow(o, options))),
        ),
      );
      continue;
    }
    loose.push(taskRow(t, options));
  }
  const n = set.tasks.length;
  const snoozeAll = () => snoozeAllSheet(set.tasks, set.tomorrowLabel);
  // The screen's main action sits under the thumb in Telegram's own button.
  const native =
    view === "overdue" && n > 0 && !select.active()
      ? mainButton(n === 1 ? "Snooze" : `Snooze all ${n}`, snoozeAll)
      : false;
  const selectButton =
    n > 1 && !select.active()
      ? h(
          "button",
          { class: "text-button", type: "button", onclick: () => select.start() },
          "Select",
        )
      : null;
  return h(
    "div",
    {},
    title(set.title ?? "", n ? `${n} open` : null, ...(selectButton ? [selectButton] : [])),
    set.listId ? quickAdd(set.listId) : null,
    view === "overdue" && n > 0 && !native
      ? h(
          "button",
          { class: "button secondary wide", type: "button", onclick: snoozeAll },
          n === 1 ? "Snooze" : `Snooze all ${n}`,
        )
      : null,
    view === "overdue" && n > 0
      ? h("p", { class: "caption" }, "Snoozing moves reminders only; deadlines stay.")
      : null,
    n === 0
      ? h("p", { class: "empty" }, view === "overdue" ? "Nothing overdue." : "No open tasks.")
      : null,
    ...groups,
    loose.length
      ? groups.length
        ? h(
            "section",
            {},
            h("h2", { class: "label" }, "Other tasks"),
            h("ul", { class: "group" }, ...loose),
          )
        : h("ul", { class: "group" }, ...loose)
      : null,
    n > 1
      ? h(
          "p",
          { class: "caption hint" },
          "Swipe a task left to snooze. Press and hold to select several.",
        )
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
  const isOpen = t.status === "open";
  const status = isOpen
    ? t.overdueLabel
      ? h("span", { class: "overdue-text" }, t.overdueLabel)
      : null
    : t.status === "completed"
      ? "Completed"
      : "Cancelled";
  const button = (label: string, onclick: () => void, kind = "secondary") =>
    h("button", { class: `button ${kind}`, type: "button", onclick }, label);
  const primaryLabel = isOpen ? "Mark done" : t.status === "cancelled" ? "Restore" : "Reopen";
  const primary = () => void (isOpen ? complete(t) : reopen(t));
  const native = mainButton(primaryLabel, primary);
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
      native ? null : button(primaryLabel, primary, ""),
      ...(isOpen
        ? [
            button("Snooze", () => snoozeSheet(t, detail.tomorrowLabel)),
            button("Edit", () => editSheet(detail)),
          ]
        : []),
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
    isOpen
      ? h(
          "div",
          { class: "actions end" },
          button("Cancel task…", () => void cancel(t), "danger"),
        )
      : null,
  );
}

function renameSeriesSheet(repeat: NonNullable<TaskDetail["repeat"]>, current: string): void {
  const input = h("input", {
    type: "text",
    value: current,
    maxlength: "200",
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
      : h("p", { class: "empty" }, "Nothing completed or cancelled recently."),
  );
}
