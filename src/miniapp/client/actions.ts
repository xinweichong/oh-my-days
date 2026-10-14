import { ApiError, api, errorText, write } from "./api";
import { h } from "./dom";
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

/**
 * The snooze choices shared by one task, a selection, and Snooze all: two
 * presets and a chosen date and time. `pick` receives the request body.
 */
export function snoozeChoices(
  agendaLabel: string,
  pick: (body: Record<string, unknown>) => void,
): Node[] {
  const date = h("input", { type: "date", required: true }) as HTMLInputElement;
  const time = h("input", { type: "time", required: true }) as HTMLInputElement;
  const choice = (label: string, body: Record<string, unknown>) =>
    h(
      "button",
      { class: "button secondary wide", type: "button", onclick: () => pick(body) },
      label,
    );
  return [
    h(
      "div",
      { class: "choice-stack" },
      choice("In 1 hour", { preset: "hour" }),
      choice(agendaLabel, { preset: "tomorrow" }),
    ),
    h(
      "form",
      {
        class: "pick-form",
        onsubmit: (event) => {
          event.preventDefault();
          pick({ date: date.value, time: time.value });
        },
      },
      h("label", {}, "Date", date),
      h("label", {}, "Time", time),
      h("button", { class: "button wide", type: "submit" }, "Snooze until then"),
    ),
  ];
}

export function snoozeSheet(task: AppTask, agendaLabel = "Tomorrow morning"): void {
  const close = sheet(
    "Snooze until when?",
    h("p", { class: "caption" }, "Snooze moves the next reminder only; the deadline stays."),
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
export function quickAdd(listId?: string): HTMLElement {
  const input = h("input", {
    type: "text",
    maxlength: "200",
    placeholder: "Add a task or event",
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
