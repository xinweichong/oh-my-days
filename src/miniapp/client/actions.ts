import { ApiError, api, errorText, write } from "./api";
import { h } from "./dom";
import {
  addDays,
  clockLabel,
  dayLabel,
  local,
  minutesOf,
  relativeDay,
  wallTime,
  weekdayShort,
} from "./local";
import { checkPop, collapse } from "./motion";
import { back, current, refresh } from "./nav";
import { haptic, telegram } from "./telegram";
import type { AppTask, ListSummary, TaskDetail } from "./types";
import { confirmAction, sheet, toast } from "./ui";

/**
 * Task actions. Each is one server write carrying the task's version; the
 * server applies the chat's own operation. A stale version refreshes the
 * screen with a notice instead of overwriting.
 */

type TaskResult = { task: AppTask };

/** Runs a write; on any failure shows why and refreshes (stale) or keeps the screen. */
async function run<T>(action: () => Promise<T>, quiet = false): Promise<T | null> {
  try {
    const result = await action();
    if (!quiet) haptic("success");
    return result;
  } catch (error) {
    haptic("error");
    toast(errorText(error));
    if (error instanceof ApiError && error.code === "stale") refresh();
    return null;
  }
}

const inFlight = new Set<string>();

/**
 * Completing answers the tap at once (the circle fills), then waits for the
 * server; only after it confirms does the row leave the list. A refusal
 * empties the circle again and says why.
 */
export async function complete(task: AppTask, row?: HTMLElement): Promise<void> {
  if (inFlight.has(task.id)) return;
  inFlight.add(task.id);
  const target = row?.querySelector<HTMLElement>(".check-target");
  const mark = target?.querySelector<HTMLElement>(".check");
  target?.classList.add("checked");
  target?.setAttribute("aria-busy", "true");
  if (mark) {
    mark.textContent = "✓";
    checkPop(mark);
  }
  haptic("tap");
  const done = await run(
    () => write<TaskResult>(`tasks/${task.id}/complete`, { version: task.version }),
    true,
  );
  inFlight.delete(task.id);
  target?.removeAttribute("aria-busy");
  if (!done) {
    target?.classList.remove("checked");
    if (mark) mark.textContent = "";
    return;
  }
  toast(`Completed: ${task.title}`, () => void reopen(done.task));
  if (row?.isConnected) {
    await collapse(row);
    row.remove();
    refresh();
  } else if (current().name === "task") {
    back();
  } else {
    refresh();
  }
}

export async function reopen(task: AppTask): Promise<void> {
  const result = await run(() =>
    write<TaskResult>(`tasks/${task.id}/reopen`, { version: task.version }),
  );
  if (result) {
    toast(`${task.status === "cancelled" ? "Restored" : "Reopened"}: ${task.title}`);
    refresh();
  }
}

/** The times offered for a chosen day. */
const TIMES = [8, 9, 12, 15, 18, 20].map((hour) => hour * 60);

/**
 * The snooze choices shared by one task, a selection, and Snooze all. Presets
 * snooze in one tap and show the time they mean; below them a day and a time
 * can be picked, with the native pickers under Other… for anything else.
 * Days and times are the user's own (local.ts). `pick` receives the request body.
 */
export function snoozeChoices(
  agendaLabel: string,
  pick: (body: Record<string, unknown>) => void,
): Node[] {
  const here = local();
  const preset = (label: string, when: string, body: Record<string, unknown>) =>
    h(
      "button",
      {
        class: "snooze-preset",
        type: "button",
        "aria-label": `${label}, ${when}`,
        onclick: () => pick(body),
      },
      h("span", { class: "preset-label" }, label),
      h("span", { class: "preset-when", "aria-hidden": "true" }, when),
    );
  const date = h("input", { type: "date", required: true }) as HTMLInputElement;
  const time = h("input", { type: "time", required: true }) as HTMLInputElement;
  const other = h(
    "form",
    {
      class: "pick-form",
      hidden: true,
      onsubmit: (event) => {
        event.preventDefault();
        pick({ date: date.value, time: time.value });
      },
    },
    h("label", {}, "Date", date),
    h("label", {}, "Time", time),
    h("button", { class: "button wide", type: "submit" }, "Snooze until then"),
  );
  // Without the user's day (an old response), offer what doesn't need it.
  if (!here) {
    other.hidden = false;
    return [
      h(
        "div",
        { class: "snooze-presets" },
        preset("In 1 hour", "From now", { preset: "hour" }),
        preset("Tomorrow", agendaLabel.replace(/^Tomorrow at /, ""), { preset: "tomorrow" }),
      ),
      other,
    ];
  }

  const now = minutesOf(here.time);
  const agenda = here.agendaHour * 60;
  const tomorrow = addDays(here.today, 1);
  // The Monday after tomorrow, so it never repeats the Tomorrow preset.
  let monday = addDays(tomorrow, 1);
  while (weekdayShort(monday) !== "Mon") monday = addDays(monday, 1);
  const presets = [
    preset("In 1 hour", `${now + 60 >= 1440 ? "Tomorrow" : "Today"} ${clockLabel(now + 60)}`, {
      preset: "hour",
    }),
    now < 17 * 60
      ? preset("This evening", `Today ${clockLabel(19 * 60)}`, {
          date: here.today,
          time: wallTime(19 * 60),
        })
      : null,
    preset("Tomorrow", `${dayLabel(tomorrow)}, ${clockLabel(agenda)}`, { preset: "tomorrow" }),
    preset("Monday", `${dayLabel(monday)}, ${clockLabel(agenda)}`, {
      date: monday,
      time: wallTime(agenda),
    }),
  ].filter((p): p is HTMLElement => p !== null);

  // A day, then a time: the button says exactly when before it's pressed.
  let chosenDay = TIMES.some((t) => t > now) ? here.today : tomorrow;
  let chosenTime: number | null = null;
  const confirm = h("button", { class: "button wide", type: "button", disabled: true }, "");
  const dayButtons: HTMLElement[] = [];
  const timeButtons: HTMLElement[] = [];
  const update = () => {
    for (const b of dayButtons) b.setAttribute("aria-pressed", String(b.dataset.day === chosenDay));
    for (const b of timeButtons) {
      const t = Number(b.dataset.time);
      const past = chosenDay === here.today && t <= now;
      (b as HTMLButtonElement).disabled = past;
      if (past && chosenTime === t) chosenTime = null;
      b.setAttribute("aria-pressed", String(chosenTime === t));
    }
    const rel = relativeDay(chosenDay, here.today);
    const day = rel === "Today" || rel === "Tomorrow" ? rel.toLowerCase() : rel;
    confirm.textContent =
      chosenTime === null ? "Pick a time" : `Snooze until ${day}, ${clockLabel(chosenTime)}`;
    (confirm as HTMLButtonElement).disabled = chosenTime === null;
  };
  for (let i = 0; i < 7; i++) {
    const day = addDays(here.today, i);
    const button = h(
      "button",
      {
        class: "day-chip",
        type: "button",
        "data-day": day,
        "aria-label": dayLabel(day),
        onclick: () => {
          chosenDay = day;
          update();
        },
      },
      h(
        "span",
        { class: "day-name", "aria-hidden": "true" },
        i === 0 ? "Today" : weekdayShort(day),
      ),
      h("span", { class: "day-num", "aria-hidden": "true" }, String(Number(day.slice(8)))),
    );
    dayButtons.push(button);
  }
  for (const t of TIMES) {
    timeButtons.push(
      h(
        "button",
        {
          class: "time-chip",
          type: "button",
          "data-time": String(t),
          onclick: () => {
            chosenTime = t;
            update();
          },
        },
        clockLabel(t),
      ),
    );
  }
  confirm.addEventListener("click", () => {
    if (chosenTime !== null) pick({ date: chosenDay, time: wallTime(chosenTime) });
  });
  const otherButton = h(
    "button",
    {
      class: "time-chip plain",
      type: "button",
      "aria-expanded": "false",
      onclick: () => {
        other.hidden = !other.hidden;
        otherButton.setAttribute("aria-expanded", String(!other.hidden));
        if (!other.hidden) date.focus();
      },
    },
    "Other…",
  );
  update();
  return [
    h("div", { class: "snooze-presets" }, ...presets),
    h("p", { class: "divider-label" }, "or pick a day and time"),
    h("div", { class: "day-strip", role: "group", "aria-label": "Day" }, ...dayButtons),
    h(
      "div",
      { class: "time-chips", role: "group", "aria-label": "Time" },
      ...timeButtons,
      otherButton,
    ),
    other,
    confirm,
  ];
}

export function snoozeSheet(task: AppTask, agendaLabel = "Tomorrow morning"): void {
  const due = task.deadline.kind === "none" ? null : task.deadline.label.replace(/^Due /, "");
  const close = sheet(
    "Snooze reminder",
    h(
      "p",
      { class: "caption" },
      due ? `The deadline stays at ${due}.` : "Snooze moves the next reminder only.",
    ),
    ...snoozeChoices(agendaLabel, (body) => {
      close();
      void (async () => {
        const result = await run(() =>
          write<TaskResult>(`tasks/${task.id}/snooze`, { version: task.version, ...body }),
        );
        if (result) {
          toast(`${result.task.snoozeLabel ?? "Snoozed"}. Deadline unchanged.`);
          refresh();
        }
      })();
    }),
  );
}

const BULK_LIMIT = 100;

/** Overdue's Snooze all: every task shown, each only if unchanged since it was shown. */
export function snoozeAllSheet(tasks: AppTask[], agendaLabel: string): void {
  const close = sheet(
    tasks.length === 1 ? "Snooze 1 task" : `Snooze all ${tasks.length}`,
    h("p", { class: "caption" }, "Moves the next reminders only; deadlines stay."),
    ...snoozeChoices(agendaLabel, (body) => {
      close();
      void (async () => {
        const summaries: string[] = [];
        for (let i = 0; i < tasks.length; i += BULK_LIMIT) {
          const items = tasks
            .slice(i, i + BULK_LIMIT)
            .map((t) => ({ id: t.id, version: t.version }));
          const result = await run(() =>
            write<{ summary: string }>("tasks/bulk", { action: "snooze", items, ...body }),
          );
          if (!result) break;
          summaries.push(result.summary);
        }
        if (summaries.length) toast(summaries.join(" "));
        refresh();
      })();
    }),
  );
}

export function editSheet(detail: TaskDetail): void {
  const t = detail.task;
  const save = async (path: string, body: Record<string, unknown>, done: string) => {
    close();
    const result = await run(() =>
      write<TaskResult>(`tasks/${t.id}/${path}`, { version: t.version, ...body }),
    );
    if (result) {
      toast(done);
      refresh();
    }
  };
  const name = h("input", {
    type: "text",
    value: t.title,
    maxlength: "200",
  }) as HTMLInputElement;
  const date = h("input", {
    type: "date",
    value: t.deadline.date ?? "",
  }) as HTMLInputElement;
  const time = h("input", {
    type: "time",
    value: t.deadline.time ?? "",
  }) as HTMLInputElement;
  const list = h(
    "select",
    {},
    ...detail.lists.map((l: ListSummary) =>
      h("option", { value: l.id, selected: l.id === t.list.id }, l.name),
    ),
  ) as HTMLSelectElement;
  const close = sheet(
    "Edit task",
    h(
      "form",
      {
        class: "stack-form",
        onsubmit: (event) => {
          event.preventDefault();
          void save("rename", { title: name.value }, `Renamed: ${name.value}`);
        },
      },
      h("label", {}, "Title", name),
      h("button", { class: "button secondary", type: "submit" }, "Rename"),
    ),
    h(
      "form",
      {
        class: "stack-form",
        onsubmit: (event) => {
          event.preventDefault();
          const deadline = time.value
            ? { kind: "datetime", date: date.value, time: time.value }
            : { kind: "date", date: date.value };
          void save("deadline", { deadline }, "Deadline changed");
        },
      },
      h(
        "div",
        { class: "pick-row" },
        h("label", {}, "Deadline", date),
        h("label", {}, "Time (optional)", time),
      ),
      h("button", { class: "button secondary", type: "submit" }, "Change deadline"),
      t.deadline.kind !== "none"
        ? h(
            "button",
            {
              class: "button plain",
              type: "button",
              onclick: () =>
                void save("deadline", { deadline: { kind: "none" } }, "Deadline removed"),
            },
            "Remove deadline",
          )
        : null,
    ),
    h(
      "form",
      {
        class: "stack-form",
        onsubmit: (event) => {
          event.preventDefault();
          void save("move", { listId: list.value }, "Moved");
        },
      },
      h("label", {}, "List", list),
      h("button", { class: "button secondary", type: "submit" }, "Move"),
    ),
  );
}

/** Cancel asks first; the confirmation is bound to the version that was shown. */
export async function cancel(task: AppTask): Promise<void> {
  const preview = await run(
    () =>
      write<{ text: string; confirmLabel: string; previewHash: string }>(
        `tasks/${task.id}/cancel-preview`,
        { version: task.version },
      ),
    true,
  );
  if (!preview) return;
  confirmAction(preview.text, preview.confirmLabel, () => {
    void (async () => {
      const result = await run(() =>
        write<TaskResult>(`tasks/${task.id}/cancel`, {
          version: task.version,
          previewHash: preview.previewHash,
        }),
      );
      if (result) {
        toast(`Cancelled: ${task.title}`, () => void reopen(result.task));
        if (current().name === "task") back();
        else refresh();
      }
    })();
  });
}

/** Rename or stop a whole series: previewed, then confirmed. */
export async function seriesChange(
  repeat: NonNullable<TaskDetail["repeat"]>,
  action: "rename" | "stop",
  title = "",
): Promise<void> {
  const preview = await run(
    () =>
      write<{ text: string; confirmLabel: string; previewHash: string }>(
        `series/${repeat.seriesId}/${action}-preview`,
        { version: repeat.version, title },
      ),
    true,
  );
  if (!preview) return;
  confirmAction(preview.text, preview.confirmLabel, () => {
    void (async () => {
      const done = await run(() =>
        write(`series/${repeat.seriesId}/${action}`, {
          version: repeat.version,
          title,
          previewHash: preview.previewHash,
        }),
      );
      if (done) {
        toast(action === "rename" ? `Series renamed: ${title}` : "Series stopped");
        refresh();
      }
    })();
  });
}

/** Opens a fresh reconnect page in the browser (the same link the chat sends). */
export async function reconnect(): Promise<void> {
  try {
    const { url } = await api<{ url: string }>("reconnect-link", {});
    const tg = telegram();
    if (tg) tg.openLink(url);
    else window.open(url, "_blank", "noopener");
  } catch (error) {
    if (error instanceof ApiError && error.code === "not_needed") {
      toast("Google Calendar is connected.");
      refresh();
      return;
    }
    toast(errorText(error));
  }
}

// --- Quick add ----------------------------------------------------------------------

type AddResult =
  | { kind: "task"; task: AppTask }
  | { kind: "event"; title: string; when: string; message: string }
  | { kind: "choose" | "unclear"; message: string; options: { label: string; draft: unknown }[] }
  | { kind: "multiple" | "no_title" | "error"; message: string };

/** The same quick-capture rules as typing in chat. */
export function quickAdd(listId?: string, listName?: string): HTMLElement {
  const input = h("input", {
    type: "text",
    maxlength: "200",
    placeholder: listName ? `Add to ${listName}` : "Add a task or event",
    enterkeyhint: "done",
    "aria-label": "Add a task or event, like Dinner Fri 7pm",
  }) as HTMLInputElement;
  const button = h("button", { class: "field-button", type: "submit" }, "Add") as HTMLButtonElement;
  const result = h("div", { class: "add-result", "aria-live": "polite" });
  const show = (added: AddResult | null) => {
    result.replaceChildren();
    if (!added) return;
    if (added.kind === "task") {
      input.value = "";
      toast(`Task added: ${added.task.title}. ${added.task.deadline.label}.`);
      refresh();
      return;
    }
    if (added.kind === "event") {
      input.value = "";
      result.append(
        h("p", { class: "caption" }, `${added.title} · ${added.when}. ${added.message}`),
      );
      return;
    }
    result.append(h("p", { class: "add-question" }, added.message));
    if ("options" in added) {
      result.append(
        h(
          "div",
          { class: "choice-stack" },
          ...added.options.map((option) =>
            h(
              "button",
              {
                class: "button secondary wide",
                type: "button",
                onclick: () => void submit({ draft: option.draft }),
              },
              option.label,
            ),
          ),
        ),
      );
    }
  };
  const submit = async (body: Record<string, unknown>) => {
    button.disabled = true;
    try {
      show(await run(() => write<AddResult>("tasks", { ...body, ...(listId ? { listId } : {}) })));
    } finally {
      button.disabled = false;
    }
  };
  return h(
    "form",
    {
      class: "quick-add",
      onsubmit: (event) => {
        event.preventDefault();
        if (input.value.trim()) void submit({ text: input.value });
      },
    },
    h("div", { class: "field-with-button" }, input, button),
    result,
  );
}
