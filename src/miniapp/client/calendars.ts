import { ApiError, errorText, write } from "./api";
import { h } from "./dom";
import { refresh } from "./nav";
import { title } from "./rows";
import { haptic } from "./telegram";
import type { CalendarEntry, CalendarsView } from "./types";
import { toast } from "./ui";

/**
 * Calendars: which are shown in views and reminders, and where new events go.
 * Each change is one write that sets an absolute value, so a repeat is harmless.
 * The screen redraws from the server's answer; a refused change says why and
 * leaves things as they were. Renaming, deleting, and sharing stay in Google.
 */

const ACCESS = { owner: "Owner", edit: "Can edit", view: "View only" } as const;

let busy = false;

async function change(path: string, body: Record<string, unknown>, done?: string): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    await write<CalendarsView>(path, body);
    haptic("success");
    if (done) toast(done);
  } catch (error) {
    haptic("error");
    toast(errorText(error));
  } finally {
    busy = false;
    refresh();
  }
}

function row(c: CalendarEntry): HTMLElement {
  const detail = [ACCESS[c.access], c.sync].join(" · ");
  return h(
    "li",
    { class: "row cal-row" },
    h(
      "div",
      { class: "row-text" },
      h("span", { class: "headline" }, c.name),
      h("span", { class: "caption" }, detail),
    ),
    c.isDefault
      ? h("span", { class: "cal-badge" }, "Default")
      : c.canBeDefault
        ? h(
            "button",
            {
              class: "time-chip plain",
              type: "button",
              "aria-label": `Make ${c.name} the default calendar for new events`,
              onclick: () =>
                void change(
                  "calendars/default",
                  { calendarId: c.id },
                  `New events go to ${c.name}.`,
                ),
            },
            "Make default",
          )
        : null,
    h(
      "button",
      {
        class: "switch",
        type: "button",
        role: "switch",
        "aria-checked": String(c.selected),
        "aria-label": `Show ${c.name}`,
        onclick: () => void change("calendars/select", { calendarId: c.id, selected: !c.selected }),
      },
      h("span", { class: "switch-knob", "aria-hidden": "true" }),
    ),
  );
}

async function syncNow(): Promise<void> {
  try {
    const { result } = await write<{ result: string }>("calendars/sync", {});
    haptic("success");
    toast(
      {
        accepted: "Checking Google Calendar now.",
        running: "A check is already running.",
        cooldown: "Checked moments ago. Try again in a minute.",
        not_connected: "Google Calendar isn't connected.",
      }[result] ?? "Done.",
    );
  } catch (error) {
    haptic("error");
    toast(errorText(error instanceof ApiError ? error : new ApiError("error", 0)));
  }
}

export function calendarsScreen(view: CalendarsView): Node {
  const shown = view.calendars.filter((c) => c.selected).length;
  return h(
    "div",
    {},
    title("Calendars", `${shown} of ${view.calendars.length} shown in views and reminders`),
    view.calendars.length
      ? h("ul", { class: "group" }, ...view.calendars.map(row))
      : h("p", { class: "empty" }, "No calendars yet. Send /settings in the chat to connect."),
    view.task
      ? h(
          "ul",
          { class: "group" },
          h(
            "li",
            { class: "row cal-row" },
            h(
              "div",
              { class: "row-text" },
              h("span", { class: "headline" }, view.task.name),
              h("span", { class: "caption" }, `Task deadlines · ${view.task.sync}`),
            ),
          ),
        )
      : null,
    h(
      "div",
      { class: "cal-actions" },
      h(
        "button",
        { class: "time-chip plain", type: "button", onclick: () => void syncNow() },
        "Sync now",
      ),
    ),
    h(
      "p",
      { class: "caption footer" },
      "To rename, delete, or share a calendar, use Google Calendar.",
    ),
  );
}
