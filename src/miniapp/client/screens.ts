import { TIDE_LINES, TIDE_LINES_VIEWBOX } from "../tide-lines";
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
import { mark, tideLines } from "./brand";
import { h } from "./dom";
import { clockLabel, countdown, daysBetween, minutesOf, relativeDay, setLocal } from "./local";
import { back, current, open, refresh, type Screen, swap } from "./nav";
import { remindersSheet } from "./reminders";
import { eventRow, labelled, navRow, savedCopyBanner, section, taskRow, title } from "./rows";
import { selection } from "./select";
import { mainButton, telegram } from "./telegram";
import type {
  AppTask,
  Home,
  Recent,
  ReminderPanel,
  TaskDetail,
  TaskSet,
  Today,
  Week,
} from "./types";
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
    case "clear":
      return clearScreen(screen.total);
  }
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// --- Home ------------------------------------------------------------------------

/**
 * Next up leads Home: the time as a figure, what it is and how soon, and a bar
 * that empties as it approaches. The countdown and bar keep time while Home is
 * showing; when the moment passes, Home refreshes to the next thing.
 */
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
  const parts = /^(\d{1,2}(?::\d{2})?)(am|pm)$/.exec(next.time);
  const lead = next.kind === "task" ? "Due" : "Next up";
  const when = h("span", { class: "next-when" }, `${lead} · ${next.when}`);
  const fill = h("span", { class: "next-bar-fill" });
  const tick = () => {
    const now = Date.now();
    const left = countdown(next.startsAt, now);
    if (left === null) return false;
    when.textContent = `${lead} · ${left}`;
    const span = Math.max(1, next.startsAt - next.since);
    const remaining = Math.min(1, Math.max(0, (next.startsAt - now) / span));
    fill.style.width = `${Math.round(remaining * 100)}%`;
    return true;
  };
  const card = h(
    "button",
    {
      class: "next-up",
      type: "button",
      "aria-label": `${lead}: ${next.time} ${next.title}${next.until ? ` until ${next.until}` : ""}`,
      onclick: go,
    },
    h(
      "span",
      { class: "next-row" },
      h(
        "span",
        { class: "next-time", "aria-hidden": "true" },
        h(
          "span",
          { class: `next-figure${(parts?.[1] ?? next.time).length > 2 ? " long" : ""}` },
          parts?.[1] ?? next.time,
        ),
        parts?.[2] ? h("span", { class: "next-suffix" }, parts[2].toUpperCase()) : null,
      ),
      h(
        "span",
        { class: "next-text", "aria-hidden": "true" },
        when,
        h("span", { class: "next-title" }, next.title),
        h(
          "span",
          { class: "meta" },
          next.until ? `until ${next.until}` : next.kind === "task" ? "Deadline" : "",
        ),
      ),
      h("span", { class: "chevron", "aria-hidden": "true" }, "›"),
    ),
    h("span", { class: "next-bar", "aria-hidden": "true" }, fill),
  );
  tick();
  const timer = window.setInterval(() => {
    if (!card.isConnected) return window.clearInterval(timer);
    if (!tick()) {
      window.clearInterval(timer);
      refreshHome();
    }
  }, 30_000);
  return card;
}

/** Re-opens Home's data when Next up has passed, if Home is still what's showing. */
function refreshHome(): void {
  if (current().name === "home") refresh();
}

function homeScreen(home: Home): Node {
  setLocal(home.local);
  const today = home.tiles.today;
  const tasks = today.tasks + today.done;
  const total = today.events + tasks;
  const behind = total - today.left;
  const [weekday, ...rest] = home.heading.split(" ");
  const status = today.left
    ? `${today.left} left today`
    : total
      ? "Everything today is behind you"
      : "Nothing scheduled today";

  // A segment per thing today (filled once it's behind you), or one bar when there are many.
  const progress =
    total > 0 && total <= 12
      ? h(
          "span",
          { class: "segments", "aria-hidden": "true" },
          ...Array.from({ length: total }, (_, i) =>
            h("span", { class: i < behind ? "segment filled" : "segment" }),
          ),
        )
      : total > 12
        ? h(
            "span",
            { class: "segments single", "aria-hidden": "true" },
            h("span", {
              class: "segment filled",
              style: `width: ${Math.round((behind / total) * 100)}%`,
            }),
          )
        : null;

  const todayTile = h(
    "button",
    {
      class: "tile wide",
      type: "button",
      "aria-label": `Today: ${total ? `${total}, ${today.left} left` : "nothing scheduled"}`,
      onclick: () => open({ name: "today" }),
    },
    h(
      "span",
      { class: "tile-top", "aria-hidden": "true" },
      h(
        "span",
        { class: "tile-text" },
        h("span", { class: "tile-title" }, "Today"),
        h(
          "span",
          { class: "caption" },
          `${plural(today.events, "event")} · ${plural(tasks, "task")}${today.done ? ` · ${today.done} done` : ""}`,
        ),
      ),
      h("span", { class: "count" }, total ? String(total) : "None"),
    ),
    progress,
  );

  const overdue = home.tiles.overdue;
  const oldest = home.tiles.overdueOldestDays;
  const age = oldest ? `oldest ${plural(oldest, "day")}` : null;
  const overdueTile = h(
    "button",
    {
      class: `tile${overdue ? " has-overdue" : ""}`,
      type: "button",
      "aria-label": `Overdue: ${overdue || "none"}${age ? `, ${age}` : ""}`,
      onclick: () => open({ name: "tasks", view: "overdue" }),
    },
    h("span", { class: "tile-label", "aria-hidden": "true" }, "Overdue"),
    h("span", { class: "count", "aria-hidden": "true" }, overdue ? String(overdue) : "None"),
    age ? h("span", { class: "caption", "aria-hidden": "true" }, age) : null,
  );

  const week = home.tiles.week;
  const dueDays = home.tiles.weekDays.filter((d) => d.count > 0);
  const weekTile = h(
    "button",
    {
      class: "tile",
      type: "button",
      "aria-label": `This week: ${week || "nothing due"}${dueDays.length ? `, on ${dueDays.map((d) => relativeDay(d.date, home.date)).join(", ")}` : ""}`,
      onclick: () => open({ name: "week" }),
    },
    h("span", { class: "tile-label", "aria-hidden": "true" }, "This week"),
    h("span", { class: "count", "aria-hidden": "true" }, week ? String(week) : "None"),
    h(
      "span",
      { class: "week-days", "aria-hidden": "true" },
      ...home.tiles.weekDays.map((d) =>
        h(
          "span",
          { class: `week-day${d.today ? " today" : ""}` },
          h("span", { class: d.count ? "dot" : "dot none" }),
          d.letter,
        ),
      ),
    ),
  );

  if (home.allClear && !clearSeen(home.date)) {
    rememberClear(home.date);
    // After Home has drawn, so Back from All clear returns to it as it was.
    window.setTimeout(() => open({ name: "clear", total }), 0);
  }

  return h(
    "div",
    { class: "home" },
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
      h(
        "div",
        { class: "home-title" },
        mark("mark home-mark", "Oh My Days"),
        h(
          "div",
          {},
          h("h1", { tabindex: "-1" }, weekday ?? home.heading),
          h("p", { class: "home-sub" }, `${rest.join(" ")} · ${status}`),
        ),
      ),
    ),
    nextUpCard(home),
    quickAdd(),
    h("div", { class: "tiles" }, todayTile, overdueTile, weekTile),
    h(
      "section",
      {},
      h("h2", { class: "section-title" }, "My lists"),
      h(
        "ul",
        { class: "group" },
        navRow("No deadline", home.tiles.noDeadline ? `${home.tiles.noDeadline}` : "None", {
          name: "tasks",
          view: "no_deadline",
        }),
        ...home.lists.map((l) =>
          navRow(
            l.name,
            l.open ? `${l.open} open` : "None",
            { name: "tasks", view: "list", list: l.id },
            l.overdue,
          ),
        ),
      ),
    ),
    h(
      "ul",
      { class: "group" },
      navRow("Completed and cancelled", home.recent ? String(home.recent) : "None", {
        name: "recent",
      }),
    ),
    home.reconnect ? null : h("p", { class: "caption footer" }, home.sync),
  );
}

// --- All clear -------------------------------------------------------------------

const CLEAR_KEY = "omd.allClear";
const clearShown = new Set<string>();

/** All clear shows once a day; storage may be unavailable, so memory backs it up. */
function clearSeen(date: string): boolean {
  if (clearShown.has(date)) return true;
  try {
    return window.localStorage.getItem(CLEAR_KEY) === date;
  } catch {
    return false;
  }
}

function rememberClear(date: string): void {
  clearShown.add(date);
  try {
    window.localStorage.setItem(CLEAR_KEY, date);
  } catch {
    // Remembered for this session only.
  }
}

function clearScreen(total: number): Node {
  const native = mainButton("Back to Home", back);
  return h(
    "div",
    { class: "all-clear" },
    tideLines("clear-lines", TIDE_LINES, TIDE_LINES_VIEWBOX),
    h(
      "div",
      { class: "clear-body" },
      mark("mark clear-mark"),
      h("h1", { tabindex: "-1" }, "Nothing left to keep in your head today."),
      h(
        "p",
        { class: "clear-text" },
        total === 1
          ? "Today’s one thing is behind you."
          : `All ${total} of today’s things are behind you.`,
      ),
    ),
    h(
      "div",
      { class: "clear-actions" },
      native
        ? null
        : h("button", { class: "button wide", type: "button", onclick: back }, "Back to Home"),
      h(
        "button",
        { class: "button plain wide", type: "button", onclick: () => swap({ name: "week" }) },
        "See this week ›",
      ),
    ),
  );
}

function todayScreen(today: Today): Node {
  setLocal(today.local);
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
  setLocal(week.local);
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

/** Which part of a list a task falls in, by the user's own day. */
function when(task: AppTask, today: string): "overdue" | "today" | "later" | "none" {
  if (task.overdue) return "overdue";
  if (task.deadline.date === null) return "none";
  return task.deadline.date === today ? "today" : "later";
}

/**
 * Overdue (recurring tasks folded under their series), No deadline, or one
 * list grouped by when: Overdue, Today, Later, No deadline.
 */
function taskSetScreen(set: TaskSet, view: "overdue" | "no_deadline" | "list"): Node {
  setLocal(set.local);
  const select = selection(set.tasks, set.lists, set.tomorrowLabel);
  const options = { showList: set.showList, tomorrowLabel: set.tomorrowLabel, selection: select };
  const n = set.tasks.length;
  const content: (Node | null)[] = [];

  if (view === "overdue") {
    const bySeries = new Map<string, AppTask[]>();
    for (const t of set.tasks) {
      if (t.seriesId) bySeries.set(t.seriesId, [...(bySeries.get(t.seriesId) ?? []), t]);
    }
    const series: Node[] = [];
    const loose: Node[] = [];
    const shown = new Set<string>();
    for (const t of set.tasks) {
      const occurrences = t.seriesId ? (bySeries.get(t.seriesId) ?? []) : [];
      if (!t.seriesId || occurrences.length < 2) {
        loose.push(taskRow(t, options));
        continue;
      }
      if (shown.has(t.seriesId)) continue;
      shown.add(t.seriesId);
      const repeats = set.series[t.seriesId];
      series.push(
        h(
          "ul",
          { class: "group" },
          h(
            "li",
            { class: "row series-head" },
            h(
              "span",
              { class: "row-text" },
              h("span", { class: "headline" }, t.title),
              h("span", { class: "meta" }, [repeats, t.list.name].filter(Boolean).join(" · ")),
            ),
            h("span", { class: "pill overdue" }, `${occurrences.length} missed`),
          ),
          ...occurrences.map((o) => taskRow(o, { ...options, showList: false, dateFirst: true })),
        ),
      );
    }
    content.push(
      series.length ? h("section", {}, h("h2", { class: "label" }, "Repeating"), ...series) : null,
      series.length
        ? labelled("One-off", "", ...loose)
        : loose.length
          ? h("ul", { class: "group" }, ...loose)
          : null,
    );
  } else if (view === "list") {
    const today = set.local.today;
    // Under "Today" a row shows only its time; the heading already says the day.
    const part = (key: ReturnType<typeof when>) =>
      set.tasks
        .filter((t) => when(t, today) === key)
        .map((t) => taskRow(t, { ...options, sameDay: key === "today" }));
    content.push(
      labelled("Overdue", "overdue", ...part("overdue")),
      labelled("Today", "today", ...part("today")),
      labelled("Later", "", ...part("later")),
      labelled("No deadline", "", ...part("none")),
    );
  } else {
    content.push(
      n ? h("ul", { class: "group" }, ...set.tasks.map((t) => taskRow(t, options))) : null,
    );
  }

  const snoozeAll = () => snoozeAllSheet(set.tasks, set.tomorrowLabel);
  // The screen's main action sits under the thumb in Telegram's own button.
  const native =
    view === "overdue" && n > 0 && !select.active()
      ? mainButton(n === 1 ? "Snooze" : `Snooze all ${n}…`, snoozeAll)
      : false;
  const selectButton =
    n > 1 && !select.active()
      ? h(
          "button",
          { class: "text-button", type: "button", onclick: () => select.start() },
          "Select",
        )
      : null;
  const ages = set.tasks.flatMap((t) =>
    t.overdue && t.deadline.date ? [daysBetween(t.deadline.date, set.local.today)] : [],
  );
  const oldest = ages.length ? Math.max(...ages) : 0;
  const overdueCount = set.tasks.filter((t) => t.overdue).length;
  const sub =
    view === "overdue"
      ? n
        ? `${plural(n, "task")}${oldest > 0 ? ` · oldest ${plural(oldest, "day")}` : ""}`
        : null
      : n
        ? `${n} open${view === "list" && overdueCount ? ` · ${overdueCount} overdue` : ""}`
        : null;
  return h(
    "div",
    {},
    title(set.title ?? "", sub, ...(selectButton ? [selectButton] : [])),
    set.listId ? quickAdd(set.listId, set.title) : null,
    view === "overdue" && n > 0 && !native
      ? h(
          "button",
          { class: "button secondary wide", type: "button", onclick: snoozeAll },
          n === 1 ? "Snooze" : `Snooze all ${n}…`,
        )
      : null,
    n === 0
      ? h("p", { class: "empty" }, view === "overdue" ? "Nothing overdue." : "No open tasks.")
      : null,
    ...content,
    n > 1
      ? h(
          "p",
          { class: "caption hint" },
          "Swipe a task left to snooze. Press and hold to select several.",
        )
      : null,
    view === "overdue" && n > 0
      ? h(
          "p",
          { class: "caption hint" },
          "Snoozing moves reminders only. Deadlines stay where they are.",
        )
      : null,
  );
}

/** "Today, 5pm", "Tomorrow", "Fri 16 Oct, 9am", or "No deadline". */
function deadlineHero(t: AppTask, today: string): string {
  if (t.deadline.kind === "none" || t.deadline.date === null) return "No deadline";
  const day = relativeDay(t.deadline.date, today);
  return t.deadline.time ? `${day}, ${clockLabel(minutesOf(t.deadline.time))}` : day;
}

function taskScreen(detail: TaskDetail): Node {
  setLocal(detail.local);
  const t = detail.task;
  const isOpen = t.status === "open";
  const facts: [string, string][] = [["List", t.list.name]];
  if (detail.reminders) facts.unshift(["Reminders", detail.reminders.summary]);
  if (detail.repeat)
    facts.push(["Repeats", `${detail.repeat.label}${detail.repeat.active ? "" : " (stopped)"}`]);
  if (t.snoozeLabel) facts.push(["Snooze", t.snoozeLabel]);
  if (detail.workTime.length) facts.push(["Work time", detail.workTime.join("; ")]);
  if (t.pending) facts.push(["Calendar", "Saving to Calendar…"]);
  const status = isOpen ? null : t.status === "completed" ? "Completed" : "Cancelled";
  // How soon, or how late: words first, colour second.
  const soon =
    isOpen && !t.overdue && t.deadline.at !== null && t.deadline.at - Date.now() < 86_400_000
      ? countdown(t.deadline.at, Date.now())
      : null;
  const accent =
    isOpen && t.overdueLabel
      ? h("span", { class: "overdue-text" }, t.overdueLabel)
      : soon
        ? h("span", { class: "soon" }, soon)
        : null;
  const button = (label: string, onclick: () => void, kind = "secondary") =>
    h("button", { class: `button ${kind}`, type: "button", onclick }, label);
  const primaryLabel = isOpen ? "Mark done" : t.status === "cancelled" ? "Restore" : "Reopen";
  const primary = () => void (isOpen ? complete(t) : reopen(t));
  const native = mainButton(primaryLabel, primary);
  const repeat = detail.repeat;
  const edit = isOpen
    ? h(
        "button",
        { class: "text-button", type: "button", onclick: () => editSheet(detail) },
        "Edit",
      )
    : null;
  return h(
    "div",
    {},
    title(t.title, status, ...(edit ? [edit] : [])),
    h(
      "div",
      { class: "group detail-card" },
      h(
        "div",
        { class: "deadline-hero" },
        h("span", { class: "label-inline" }, "Deadline"),
        h(
          "p",
          { class: "hero-line" },
          h("span", { class: "hero-when" }, deadlineHero(t, detail.local.today)),
          accent,
        ),
      ),
      h(
        "dl",
        { class: "fact-rows" },
        ...facts.map(([k, v]) => h("div", { class: "fact" }, h("dt", {}, k), h("dd", {}, v))),
      ),
    ),
    h(
      "div",
      { class: "actions" },
      native ? null : button(primaryLabel, primary, ""),
      isOpen ? button("Snooze…", () => snoozeSheet(t, detail.tomorrowLabel)) : null,
      detail.reminders
        ? button("Reminders…", () =>
            remindersSheet(
              t.title,
              { kind: "task", taskId: t.id },
              detail.reminders as ReminderPanel,
            ),
          )
        : null,
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
      ? h(
          "section",
          {},
          h("h2", { class: "label" }, "History"),
          h(
            "ol",
            { class: "group timeline" },
            ...[...detail.history]
              .reverse()
              .map((line, i) =>
                h(
                  "li",
                  { class: i === 0 ? "moment latest" : "moment" },
                  h("span", { class: "moment-dot", "aria-hidden": "true" }),
                  h("span", {}, line),
                ),
              ),
          ),
        )
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
