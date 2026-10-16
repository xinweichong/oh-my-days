import { MAX_SELECTION } from "../limits";
import { snoozeChoices } from "./actions";
import { ApiError, errorText, write } from "./api";
import { bulkSummary, inParts } from "./bulk";
import { h } from "./dom";
import { onBack, refresh } from "./nav";
import type { Selection } from "./rows";
import { haptic, mainButton } from "./telegram";
import type { AppTask, ListSummary } from "./types";
import { confirmAction, sheet, toast } from "./ui";

/**
 * Multi-select (step 5c): a long press or the Select button starts it,
 * Telegram's main button completes the selection, and a bar offers Snooze,
 * Move, and Cancel. Each task changes only if still at the version shown; one
 * summary reports the result. Cancelling is confirmed for exactly the
 * selected set. Back or Stop selecting leaves without changing anything.
 */

interface BulkResult {
  summary: string;
  applied: number;
}

let active: Controller | null = null;

/** Ends any selection; returns true if one was active. Navigation passes `redraw: false`. */
export function endSelection(redraw = true): boolean {
  if (!active) return false;
  active.end(redraw);
  return true;
}

onBack(() => endSelection());

class Controller implements Selection {
  private readonly chosen = new Map<string, AppTask>();
  private on = false;
  private bar: HTMLElement | null = null;
  private readonly completeAll = () => void this.bulk("complete", "Completed");

  constructor(
    private readonly tasks: AppTask[],
    private readonly lists: ListSummary[],
    private readonly tomorrowLabel: string,
  ) {}

  active(): boolean {
    return this.on;
  }

  has(task: AppTask): boolean {
    return this.chosen.has(task.id);
  }

  /** Starts selecting, with `task` chosen, or with nothing chosen (Select button). */
  start(task?: AppTask): void {
    if (active && active !== this) active.end(false);
    active = this;
    this.on = true;
    if (task) this.chosen.set(task.id, task);
    document.body.classList.add("selecting");
    this.update();
  }

  toggle(task: AppTask): void {
    if (this.chosen.has(task.id)) this.chosen.delete(task.id);
    else if (this.chosen.size >= MAX_SELECTION) {
      toast(`Up to ${MAX_SELECTION} at a time.`);
      return;
    } else this.chosen.set(task.id, task);
    haptic("select");
    this.update();
  }

  end(redraw = true): void {
    this.on = false;
    this.chosen.clear();
    this.bar?.remove();
    this.bar = null;
    document.body.classList.remove("selecting");
    mainButton(null);
    if (active === this) active = null;
    if (redraw) refresh();
  }

  private items() {
    return [...this.chosen.values()].map((t) => ({ id: t.id, version: t.version }));
  }

  private update(): void {
    const n = this.chosen.size;
    const all = n === Math.min(this.tasks.length, MAX_SELECTION);
    const native = n > 0 ? mainButton(`Complete ${n}`, this.completeAll) : mainButton(null);
    const action = (label: string, onclick: () => void, kind = "secondary") =>
      h("button", { class: `button ${kind}`, type: "button", disabled: n === 0, onclick }, label);
    const bar = h(
      "div",
      { class: "select-bar", role: "toolbar", "aria-label": "Selection" },
      h(
        "div",
        { class: "select-head" },
        h(
          "span",
          { class: "select-count", role: "status" },
          n === 0 ? "Choose tasks" : `${n} selected`,
        ),
        h(
          "button",
          {
            class: "text-button",
            type: "button",
            onclick: () => {
              if (all) this.chosen.clear();
              else {
                for (const t of this.tasks.slice(0, MAX_SELECTION)) this.chosen.set(t.id, t);
                if (this.tasks.length > MAX_SELECTION) {
                  toast(`Selected the first ${MAX_SELECTION}; up to ${MAX_SELECTION} at a time.`);
                }
              }
              this.update();
            },
          },
          all ? "Select none" : "Select all",
        ),
        h(
          "button",
          { class: "text-button", type: "button", onclick: () => this.end() },
          "Stop selecting",
        ),
      ),
      h(
        "div",
        { class: "select-actions" },
        native ? null : action(`Complete ${n}`, this.completeAll, ""),
        action("Snooze", () => this.snooze()),
        action("Move", () => this.move()),
        action("Cancel tasks…", () => void this.cancel(), "danger"),
      ),
    );
    if (this.bar) this.bar.replaceWith(bar);
    else document.body.append(bar);
    this.bar = bar;
    this.paint();
  }

  /** Marks selected rows in place, without reloading the screen. */
  private paint(): void {
    for (const row of document.querySelectorAll<HTMLElement>(".row.task[data-id]")) {
      const id = row.dataset.id ?? "";
      const task = this.tasks.find((t) => t.id === id);
      const on = this.chosen.has(id);
      row.classList.toggle("is-selected", on);
      row.classList.add("in-selection");
      const target = row.querySelector<HTMLElement>(".check-target");
      target?.setAttribute("aria-pressed", String(on));
      if (task) target?.setAttribute("aria-label", `${on ? "Deselect" : "Select"}: ${task.title}`);
      const mark = row.querySelector<HTMLElement>(".check-target .check");
      if (mark) mark.textContent = on ? "✓" : "";
    }
  }

  /** One change for the whole selection, sent in parts the server accepts. */
  private async bulk(
    action: string,
    verb: string,
    extra: Record<string, unknown> = {},
    note = "",
  ): Promise<void> {
    if (this.chosen.size === 0) return;
    const items = this.items();
    const result = await inParts(items, (part) =>
      write<BulkResult>("tasks/bulk", { action, items: part, ...extra }),
    );
    haptic(result.error ? "error" : "success");
    toast(bulkSummary(verb, items.length, result, note, errorText));
    this.end();
  }

  private snooze(): void {
    const close = sheet(
      `Snooze ${this.chosen.size}`,
      h("p", { class: "caption" }, "Moves the next reminders only; deadlines stay."),
      ...snoozeChoices(this.tomorrowLabel, (body) => {
        close();
        void this.bulk("snooze", "Snoozed", body, " Deadlines unchanged.");
      }),
    );
  }

  private move(): void {
    const close = sheet(
      `Move ${this.chosen.size} to`,
      h(
        "div",
        { class: "choice-stack" },
        ...this.lists.map((l) =>
          h(
            "button",
            {
              class: "button secondary wide",
              type: "button",
              onclick: () => {
                close();
                void this.bulk("move", `Moved to ${l.name}:`, { listId: l.id });
              },
            },
            l.name,
          ),
        ),
      ),
    );
  }

  private async cancel(): Promise<void> {
    const items = this.items();
    try {
      // One preview for the whole selection; each part is confirmed for exactly its tasks.
      const preview = await write<{
        text: string;
        confirmLabel: string;
        chunks: { items: { id: string; version: number }[]; previewHash: string }[];
      }>("tasks/bulk-cancel-preview", { items });
      confirmAction(preview.text, preview.confirmLabel, () => {
        void (async () => {
          // The server's parts, one request each.
          const result = await inParts(
            preview.chunks,
            async ([chunk]) =>
              chunk ? write<BulkResult>("tasks/bulk-cancel", chunk) : { applied: 0 },
            1,
          );
          toast(bulkSummary("Cancelled", items.length, result, "", errorText));
          this.end();
        })();
      });
    } catch (error) {
      toast(errorText(error));
      if (error instanceof ApiError && error.code === "stale") this.end();
    }
  }
}

export interface Selector extends Selection {
  start(task?: AppTask): void;
}

export function selection(tasks: AppTask[], lists: ListSummary[], tomorrowLabel: string): Selector {
  return active?.active() ? active : new Controller(tasks, lists, tomorrowLabel);
}
