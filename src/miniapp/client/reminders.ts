import { ApiError, api, errorText, write } from "./api";
import { h, replace } from "./dom";
import { refresh } from "./nav";
import { haptic, telegram } from "./telegram";
import type { AppEvent, EventReminders, ReminderPanel, ReminderTarget } from "./types";
import { sheet, toast } from "./ui";

/**
 * Reminders for one task or event (ADR 0008): presets to tap on and off, the
 * item's own reminders with Remove, typed ones ("45m, 1 day before 6pm"),
 * Default, and None. Each change is one write carrying the version shown; a
 * stale or refused change shows the current reminders and says why.
 */

type Result = { reminders: ReminderPanel; notes?: string[] };

export function remindersSheet(
  title: string,
  target: ReminderTarget,
  panel: ReminderPanel,
  options: { when?: string; lead?: Node } = {},
): void {
  let state = panel;
  let busy = false;
  const body = h("div", { class: "reminder-sheet" });

  const send = async (change: Record<string, unknown>, done?: string) => {
    if (busy) return;
    busy = true;
    try {
      const result = await write<Result>("reminders", {
        target,
        version: state.version,
        ...change,
      });
      state = result.reminders;
      haptic("success");
      const notes = result.notes ?? [];
      if (notes.length || done) toast([done, ...notes].filter(Boolean).join(" "));
      refresh();
    } catch (error) {
      haptic("error");
      const body = error instanceof ApiError ? error.body : null;
      if (body?.reminders) state = body.reminders as ReminderPanel;
      toast(typeof body?.message === "string" ? body.message : errorText(error));
    } finally {
      busy = false;
      render();
    }
  };
  const codes = () => state.items.map((i) => i.code);

  const render = () => {
    const full = state.items.length >= state.max;
    const input = h("input", {
      type: "text",
      maxlength: "200",
      placeholder: state.timed ? "45m, 1 day before 6pm, Thu 9am" : "1 day before 6pm, Thu 9am",
      "aria-label": "Your own reminders",
      autocomplete: "off",
    }) as HTMLInputElement;
    replace(
      body,
      options.when ? h("p", { class: "caption" }, options.when) : null,
      options.lead ?? null,
      state.items.length
        ? h(
            "ul",
            { class: "reminder-list" },
            ...state.items.map((item) =>
              h(
                "li",
                {},
                h("span", {}, item.label),
                h(
                  "button",
                  {
                    class: "text-button",
                    type: "button",
                    "aria-label": `Remove ${item.label}`,
                    onclick: () =>
                      void send({ action: "set", codes: codes().filter((c) => c !== item.code) }),
                  },
                  "Remove",
                ),
              ),
            ),
          )
        : h("p", { class: "reminder-none" }, state.summary),
      h("p", { class: "divider-label" }, "Quick choices"),
      h(
        "div",
        { class: "time-chips" },
        ...state.presets.map((p) =>
          h(
            "button",
            {
              class: "time-chip",
              type: "button",
              "aria-pressed": p.on ? "true" : "false",
              disabled: !p.on && full,
              onclick: () =>
                void send({
                  action: "set",
                  codes: p.on ? codes().filter((c) => c !== p.code) : [...codes(), p.code],
                }),
            },
            p.label,
          ),
        ),
      ),
      h(
        "form",
        {
          class: "stack-form",
          onsubmit: (event) => {
            event.preventDefault();
            if (input.value.trim()) void send({ action: "add", text: input.value.trim() });
          },
        },
        h("label", {}, "Add your own", input),
        h("button", { class: "button secondary", type: "submit", disabled: full }, "Add"),
        full
          ? h("p", { class: "caption" }, `Up to ${state.max} each. Remove one to add another.`)
          : null,
      ),
      h(
        "div",
        { class: "actions" },
        state.custom
          ? h(
              "button",
              {
                class: "button plain",
                type: "button",
                onclick: () => void send({ action: "default" }, "Back to the default."),
              },
              "Use default",
            )
          : null,
        state.items.length
          ? h(
              "button",
              {
                class: "button plain",
                type: "button",
                onclick: () => void send({ action: "set", codes: [] }, "No reminders."),
              },
              "No reminders",
            )
          : null,
      ),
    );
  };
  render();
  sheet(title, body);
}

/** An event: its reminders, and Open in Google Calendar. */
export async function eventSheet(event: AppEvent): Promise<void> {
  const openLink = () => {
    const tg = telegram();
    if (tg) tg.openLink(event.link);
    else window.open(event.link, "_blank", "noopener");
  };
  let detail: EventReminders;
  try {
    detail = await api<EventReminders>(
      `event-reminders?calendar=${encodeURIComponent(event.calendarId)}&event=${encodeURIComponent(event.eventId)}`,
    );
  } catch (error) {
    // Without reminders (an old event, Google unreachable), the link still works.
    if (error instanceof ApiError && error.status === 404) return openLink();
    toast(errorText(error));
    return;
  }
  remindersSheet(detail.title, detail.target, detail.reminders, {
    when: detail.when,
    lead: h(
      "button",
      { class: "button secondary wide", type: "button", onclick: openLink },
      "Open in Google Calendar",
    ),
  });
}
