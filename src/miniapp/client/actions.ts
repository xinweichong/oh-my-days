import { ApiError, errorText, write } from "./api";
import { h } from "./dom";
import { refresh } from "./nav";
import { telegram } from "./telegram";
import type { AppTask, ListSummary, TaskDetail } from "./types";
import { confirmAction, sheet, toast } from "./ui";

/**
 * Task actions. Each is one server write carrying the task's version; the
 * server applies the chat's own operation. A stale version refreshes the
 * screen with a notice instead of overwriting.
 */

type TaskResult = { task: AppTask };

function haptic(kind: "success" | "error"): void {
  telegram()?.HapticFeedback?.notificationOccurred(kind);
}

/** Runs a write; on any failure shows why and refreshes (stale) or keeps the screen. */
async function run<T>(action: () => Promise<T>): Promise<T | null> {
  try {
    const result = await action();
    haptic("success");
    return result;
  } catch (error) {
    haptic("error");
    toast(errorText(error));
    if (error instanceof ApiError && error.code === "stale") refresh();
    return null;
  }
}

export async function complete(task: AppTask): Promise<void> {
  const done = await run(() =>
    write<TaskResult>(`tasks/${task.id}/complete`, { version: task.version }),
  );
  if (!done) return;
  toast(`Completed: ${task.title}`, () => void reopen(done.task));
  refresh();
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

export function snoozeSheet(task: AppTask, agendaLabel = "Tomorrow morning"): void {
  const send = async (body: Record<string, unknown>) => {
    close();
    const result = await run(() =>
      write<TaskResult>(`tasks/${task.id}/snooze`, { version: task.version, ...body }),
    );
    if (result) {
      toast(`${result.task.snoozeLabel ?? "Snoozed"}. Deadline unchanged.`);
      refresh();
    }
  };
  const date = h("input", {
    type: "date",
    "aria-label": "Date",
    required: true,
  }) as HTMLInputElement;
  const time = h("input", {
    type: "time",
    "aria-label": "Time",
    required: true,
  }) as HTMLInputElement;
  const close = sheet(
    "Snooze until when?",
    h("p", { class: "caption" }, "Snooze moves the next reminder only; the deadline stays."),
    h(
      "button",
      {
        class: "button secondary wide",
        type: "button",
        onclick: () => void send({ preset: "hour" }),
      },
      "In 1 hour",
    ),
    h(
      "button",
      {
        class: "button secondary wide",
        type: "button",
        onclick: () => void send({ preset: "tomorrow" }),
      },
      agendaLabel,
    ),
    h(
      "form",
      {
        class: "inline-form",
        onsubmit: (event) => {
          event.preventDefault();
          void send({ date: date.value, time: time.value });
        },
      },
      date,
      time,
      h("button", { class: "button", type: "submit" }, "Snooze"),
    ),
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
    "aria-label": "Title",
  }) as HTMLInputElement;
  const date = h("input", {
    type: "date",
    value: t.deadline.date ?? "",
    "aria-label": "Deadline date",
  }) as HTMLInputElement;
  const time = h("input", {
    type: "time",
    "aria-label": "Deadline time (optional)",
    value: t.deadline.time ?? "",
  }) as HTMLInputElement;
  const list = h(
    "select",
    { "aria-label": "List" },
    ...detail.lists.map((l: ListSummary) =>
      h("option", { value: l.id, selected: l.id === t.list.id }, l.name),
    ),
  ) as HTMLSelectElement;
  const close = sheet(
    `Edit ${t.title}`,
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
      h("label", {}, "Deadline", date),
      h("label", {}, "Time (optional)", time),
      h("button", { class: "button secondary", type: "submit" }, "Change deadline"),
      t.deadline.kind !== "none"
        ? h(
            "button",
            {
              class: "button secondary",
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
  const preview = await run(() =>
    write<{ text: string; confirmLabel: string; previewHash: string }>(
      `tasks/${task.id}/cancel-preview`,
      { version: task.version },
    ),
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
        refresh();
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
  const preview = await run(() =>
    write<{ text: string; confirmLabel: string; previewHash: string }>(
      `series/${repeat.seriesId}/${action}-preview`,
      { version: repeat.version, title },
    ),
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
    placeholder: "Add a task or event, like Dinner Fri 7pm",
    "aria-label": "Add a task or event",
  }) as HTMLInputElement;
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
    result.append(h("p", {}, added.message));
    if ("options" in added) {
      for (const option of added.options) {
        result.append(
          h(
            "button",
            {
              class: "button secondary wide",
              type: "button",
              onclick: () => void submit({ draft: option.draft }),
            },
            option.label,
          ),
        );
      }
    }
  };
  const submit = async (body: Record<string, unknown>) =>
    show(await run(() => write<AddResult>("tasks", { ...body, ...(listId ? { listId } : {}) })));
  return h(
    "form",
    {
      class: "quick-add",
      onsubmit: (event) => {
        event.preventDefault();
        if (input.value.trim()) void submit({ text: input.value });
      },
    },
    h(
      "div",
      { class: "quick-add-row" },
      input,
      h("button", { class: "button", type: "submit" }, "Add"),
    ),
    result,
  );
}
