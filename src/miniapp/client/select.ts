import { ApiError, errorText, write } from "./api";
import { h } from "./dom";
import { refresh } from "./nav";
import type { Selection } from "./rows";
import { telegram } from "./telegram";
import type { AppTask, ListSummary } from "./types";
import { confirmAction, sheet, toast } from "./ui";

/**
 * Multi-select (step 5c): a long press starts it, Telegram's main button
 * completes the selection, and a bar offers Snooze, Move, and Cancel. Each
 * task changes only if still at the version shown; one summary reports the
 * result. Cancelling is confirmed for exactly the selected set.
 */

interface BulkResult {
  summary: string;
}

let active: Controller | null = null;

/** Ends any selection (on navigation). */
export function endSelection(): void {
  active?.end();
}

class Controller implements Selection {
  private readonly chosen = new Map<string, AppTask>();
  private on = false;
  private bar: HTMLElement | null = null;
  private readonly mainClick = () => void this.bulk("complete");

  constructor(
    private readonly lists: ListSummary[],
    private readonly tomorrowLabel: string,
  ) {}

  active(): boolean {
    return this.on;
  }

  has(task: AppTask): boolean {
    return this.chosen.has(task.id);
  }

  start(task: AppTask): void {
    active?.end();
    active = this;
    this.on = true;
    this.chosen.set(task.id, task);
    this.update();
  }

  toggle(task: AppTask): void {
    if (this.chosen.has(task.id)) this.chosen.delete(task.id);
    else this.chosen.set(task.id, task);
    if (this.chosen.size === 0) this.end();
    else this.update();
  }

  end(): void {
    this.on = false;
    this.chosen.clear();
    this.bar?.remove();
    this.bar = null;
    const main = telegram()?.MainButton;
    main?.offClick(this.mainClick);
    main?.hide();
    if (active === this) active = null;
    refresh();
  }

  private items() {
    return [...this.chosen.values()].map((t) => ({ id: t.id, version: t.version }));
  }

  private update(): void {
    const n = this.chosen.size;
    const main = telegram()?.MainButton;
    if (main) {
      main.setText(`Complete ${n}`);
      main.offClick(this.mainClick);
      main.onClick(this.mainClick);
      main.show();
    }
    this.bar?.remove();
    this.bar = h(
      "div",
      { class: "select-bar", role: "toolbar", "aria-label": `${n} selected` },
      h("span", { class: "select-count" }, `${n} selected`),
      main
        ? null
        : h(
            "button",
            { class: "button", type: "button", onclick: this.mainClick },
            `Complete ${n}`,
          ),
      h(
        "button",
        { class: "button secondary", type: "button", onclick: () => this.snooze() },
        "Snooze",
      ),
      h(
        "button",
        { class: "button secondary", type: "button", onclick: () => this.move() },
        "Move",
      ),
      h(
        "button",
        { class: "button danger", type: "button", onclick: () => void this.cancel() },
        "Cancel",
      ),
      h("button", { class: "text-button", type: "button", onclick: () => this.end() }, "Done"),
    );
    document.body.append(this.bar);
    this.paint();
  }

  /** Marks selected rows in place, without reloading the screen. */
  private paint(): void {
    document.querySelectorAll<HTMLElement>(".row.task[data-id]").forEach((row) => {
      const on = this.chosen.has(row.dataset.id ?? "");
      row.classList.toggle("is-selected", on);
      const target = row.querySelector<HTMLElement>(".check-target");
      target?.setAttribute("aria-pressed", String(on));
      const mark = row.querySelector<HTMLElement>(".check-target .check");
      if (mark) mark.textContent = on ? "✓" : "";
    });
  }

  private async bulk(action: string, extra: Record<string, unknown> = {}): Promise<void> {
    try {
      const result = await write<BulkResult>("tasks/bulk", {
        action,
        items: this.items(),
        ...extra,
      });
      telegram()?.HapticFeedback?.notificationOccurred("success");
      toast(result.summary);
    } catch (error) {
      telegram()?.HapticFeedback?.notificationOccurred("error");
      toast(errorText(error));
    }
    this.end();
  }

  private snooze(): void {
    const close = sheet(
      `Snooze ${this.chosen.size}`,
      h("p", { class: "caption" }, "Moves the next reminder only; deadlines stay."),
      h(
        "button",
        {
          class: "button secondary wide",
          type: "button",
          onclick: () => {
            close();
            void this.bulk("snooze", { preset: "hour" });
          },
        },
        "In 1 hour",
      ),
      h(
        "button",
        {
          class: "button secondary wide",
          type: "button",
          onclick: () => {
            close();
            void this.bulk("snooze", { preset: "tomorrow" });
          },
        },
        this.tomorrowLabel,
      ),
    );
  }

  private move(): void {
    const close = sheet(
      `Move ${this.chosen.size} to`,
      ...this.lists.map((l) =>
        h(
          "button",
          {
            class: "button secondary wide",
            type: "button",
            onclick: () => {
              close();
              void this.bulk("move", { listId: l.id });
            },
          },
          l.name,
        ),
      ),
    );
  }

  private async cancel(): Promise<void> {
    const items = this.items();
    try {
      const preview = await write<{ text: string; confirmLabel: string; previewHash: string }>(
        "tasks/bulk-cancel-preview",
        { items },
      );
      confirmAction(preview.text, preview.confirmLabel, () => {
        void (async () => {
          try {
            const result = await write<BulkResult>("tasks/bulk-cancel", {
              items,
              previewHash: preview.previewHash,
            });
            toast(result.summary);
          } catch (error) {
            toast(errorText(error));
          }
          this.end();
        })();
      });
    } catch (error) {
      toast(errorText(error));
      if (error instanceof ApiError && error.code === "stale") this.end();
    }
  }
}

export function selection(lists: ListSummary[], tomorrowLabel: string): Selection {
  return active?.active() ? active : new Controller(lists, tomorrowLabel);
}
