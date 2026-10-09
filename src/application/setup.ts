import { isWritable } from "../calendar/port";
import { agendaDueDate } from "../domain/schedule";
import { COMMON_ZONES, matchCity, nextRecentZones, zoneLabel } from "../domain/timezones";
import type { AppConfig } from "../env";
import { accessEndsAt } from "../jobs/access-expiry";
import { requestForcePoll, type SyncSummary, syncSummary } from "../jobs/calendar-sync";
import type { Clock } from "../shared/clock";
import type { IdGenerator } from "../shared/ids";
import { lastTickAt, MAX_TICK_AGE_MS } from "../storage/app-state";
import { deleteContactStatement, listContacts } from "../storage/contacts";
import {
  findConnection,
  listStoredCalendars,
  type StoredCalendar,
  setCalendarSelectedStatement,
} from "../storage/google";
import {
  clearPendingInputStatement,
  type PendingInputKind,
  type UiAction,
} from "../storage/interactions";
import { claimAgendaStatement } from "../storage/reminders";
import {
  AGENDA_HOURS,
  advanceSetupStatement,
  REMINDER_LEADS,
  type SetupStep,
  setScheduleSettingStatement,
  setTimezoneStatement,
  setUserCalendarStatement,
  type UserRecord,
} from "../storage/users";
import type { InlineKeyboardButton, InlineKeyboardMarkup } from "../telegram/api";
import { formatShortStart, formatWallTime } from "../telegram/format";
import { TAGLINE } from "../telegram/messages";
import type { InboundCallback, InboundMessage } from "../telegram/update";
import { CREATE_CALENDAR, type CreateCalendarIntent } from "./calendar-operations";
import { guidedPrompt } from "./cancel";
import { connectMessage } from "./google-connection";
import { prepareProposal } from "./proposals";
import { ActionButtons, combine, message, type Reaction } from "./reactions";
import { answer, keyboardMessage, removeButtons } from "./ui";

export const TASK_CALENDAR_NAME = "Tasks - Oh My Days";

/** Bounds picker size well inside Telegram's keyboard limits. */
const MAX_PICKER_CALENDARS = 24;

export interface SetupDeps {
  db: D1Database;
  clock: Clock;
  ids: IdGenerator;
  config: AppConfig;
}

/** Pickers opened from /settings change one setting; during setup they advance it. */
type Mode = "setup" | "settings";

const NEXT_STEP: Partial<Record<SetupStep, SetupStep>> = {
  calendars: "default",
  default: "task_calendar",
  task_calendar: "timezone",
  timezone: "done",
};

/** The prompt for the user's current setup step. */
export async function setupPrompt(deps: SetupDeps, user: UserRecord): Promise<Reaction> {
  switch (user.setupStep) {
    case "connect":
      return connectMessage(
        deps,
        user,
        "connect",
        `Oh My Days\n${TAGLINE}\n\nConnect Google Calendar to get started. The link expires in 10 minutes.`,
      );
    case "calendars":
      return calendarPicker(deps, user, "setup", null);
    case "default":
      return defaultPicker(deps, user, "setup");
    case "task_calendar":
      return taskCalendarPrompt(deps, user);
    case "timezone":
      return timezonePrompt(deps, user, "setup");
    case "done":
      return summary(deps, user, "Setup complete.");
  }
}

/** Moves setup to the next step and returns that step's prompt. */
async function advance(
  deps: SetupDeps,
  user: UserRecord,
  from: SetupStep,
  changes: Partial<UserRecord> = {},
): Promise<Reaction> {
  const to = NEXT_STEP[from];
  if (!to || user.setupStep !== from) return { replies: [] };
  const now = deps.clock.now();
  const updated = { ...user, ...changes, setupStep: to };
  const next = await setupPrompt(deps, updated);
  // Setup finishing after 8am: today's agenda is covered; the first is tomorrow's.
  const covered = to === "done" ? agendaDueDate(now, updated.timezone, updated.agendaHour) : null;
  return combine(
    {
      replies: [],
      statements: (db, guard) => [
        advanceSetupStatement(db, user.id, from, to, now, guard),
        ...(covered ? [claimAgendaStatement(db, user.id, covered, "setup", now)] : []),
      ],
    },
    next,
  );
}

// --- Calendars ---------------------------------------------------------------

function eventCalendars(user: UserRecord, calendars: StoredCalendar[]): StoredCalendar[] {
  return calendars.filter(
    (c) => c.listed && c.accessRole !== "freeBusyReader" && c.calendarId !== user.taskCalendarId,
  );
}

async function calendarPicker(
  deps: SetupDeps,
  user: UserRecord,
  mode: Mode,
  editMessageId: number | null,
  overrides: Map<string, boolean> = new Map(),
): Promise<Reaction> {
  const all = eventCalendars(user, await listStoredCalendars(deps.db, user.id));
  const shown = all.slice(0, MAX_PICKER_CALENDARS);
  const buttons = new ActionButtons(deps.ids, user.id, deps.clock.now());
  const rows: InlineKeyboardButton[][] = shown.map((c) => {
    const selected = overrides.get(c.calendarId) ?? c.selected;
    const label = `${selected ? "✓ " : ""}${c.summary}${isWritable(c.accessRole) ? "" : " (view only)"}`;
    return [
      buttons.button(label, "toggle_calendar", {
        calendarId: c.calendarId,
        select: !selected,
        mode,
      }),
    ];
  });
  rows.push([buttons.button("Done", "calendars_done", { mode })]);
  const more = all.length > shown.length ? `\nShowing ${shown.length} of ${all.length}.` : "";
  const text = `Choose the calendars to include in views and reminders. Tap to select or unselect; ✓ means selected.${more}`;
  const call = keyboardMessage(user, text, { inline_keyboard: rows }, editMessageId);
  return { replies: [call], statements: (db, guard) => buttons.statements(db, guard) };
}

// --- Default calendar --------------------------------------------------------

async function defaultPicker(deps: SetupDeps, user: UserRecord, mode: Mode): Promise<Reaction> {
  const writable = eventCalendars(user, await listStoredCalendars(deps.db, user.id))
    .filter((c) => isWritable(c.accessRole))
    .sort((a, b) => Number(b.selected) - Number(a.selected))
    .slice(0, MAX_PICKER_CALENDARS);
  const buttons = new ActionButtons(deps.ids, user.id, deps.clock.now());
  const rows = writable.map((c) => [
    buttons.button(
      `${c.calendarId === user.defaultCalendarId ? "✓ " : ""}${c.summary}`,
      "choose_default",
      { calendarId: c.calendarId, mode },
    ),
  ]);
  rows.push([buttons.button("Create a new calendar", "new_default", { mode })]);
  return {
    replies: [
      keyboardMessage(
        user,
        "Choose the default calendar for new events. Only calendars you can edit are shown.",
        { inline_keyboard: rows },
        null,
      ),
    ],
    statements: (db, guard) => buttons.statements(db, guard),
  };
}

// --- Task calendar -----------------------------------------------------------

async function taskCalendarPrompt(deps: SetupDeps, user: UserRecord): Promise<Reaction> {
  const calendars = await listStoredCalendars(deps.db, user.id);
  const buttons = new ActionButtons(deps.ids, user.id, deps.clock.now());
  // A matching name alone is not proof of identity, so an existing calendar is
  // linked only when the user chooses it.
  const existing = calendars.find(
    (c) => c.listed && c.accessRole === "owner" && c.summary === TASK_CALENDAR_NAME,
  );
  const text = existing
    ? `A calendar named "${TASK_CALENDAR_NAME}" already exists in your account. Use it for task deadlines, or create a new one?`
    : `Task deadlines go in a separate calendar, "${TASK_CALENDAR_NAME}". Deadlines there don't mark you as busy.`;
  const row = existing
    ? [
        buttons.button("Use existing", "use_task_calendar", { calendarId: existing.calendarId }),
        buttons.button("Create new", "create_task_calendar", {}),
      ]
    : [buttons.button("Create calendar", "create_task_calendar", {})];
  return {
    replies: [keyboardMessage(user, text, { inline_keyboard: [row] }, null)],
    statements: (db, guard) => buttons.statements(db, guard),
  };
}

// --- Timezone ----------------------------------------------------------------

function timezonePrompt(deps: SetupDeps, user: UserRecord, mode: Mode): Reaction {
  const buttons = new ActionButtons(deps.ids, user.id, deps.clock.now());
  const row = [
    buttons.button(`Keep ${user.timezone}`, "keep_timezone", { mode }),
    buttons.button("Change timezone", "change_timezone", { mode }),
  ];
  return {
    replies: [
      keyboardMessage(
        user,
        `Your timezone is ${user.timezone}. Dates, agendas, and reminders use it.`,
        { inline_keyboard: [row] },
        null,
      ),
    ],
    statements: (db, guard) => buttons.statements(db, guard),
  };
}

/** Accepts IANA zone names only, returned in canonical form. */
export function canonicalTimezone(input: string): string | null {
  const value = input.trim();
  if (!/^(?:UTC|[A-Za-z]+(?:\/[A-Za-z0-9_+-]+)+)$/.test(value)) return null;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

// --- Summary, settings, health ---------------------------------------------------

async function settingsLines(deps: SetupDeps, user: UserRecord): Promise<string[]> {
  const calendars = await listStoredCalendars(deps.db, user.id);
  const name = (id: string | null) =>
    calendars.find((c) => c.calendarId === id)?.summary ?? "Not set";
  const selected = eventCalendars(user, calendars).filter((c) => c.selected);
  return [
    `Calendars: ${selected.map((c) => c.summary).join(", ") || "None selected"}`,
    `Default for new events: ${name(user.defaultCalendarId)}`,
    `Task deadlines: ${name(user.taskCalendarId)}`,
    `Timezone: ${user.timezone}`,
    `Daily agenda: ${hourLabel(user.agendaHour)}`,
    `Default reminder: ${leadLabel(user.reminderMinutes)}`,
  ];
}

function hourLabel(hour: number): string {
  return formatWallTime(`${String(hour).padStart(2, "0")}:00`);
}

/** "1 hour before", "30 minutes before". */
export function leadLabel(minutes: number): string {
  if (minutes % 60 === 0) return minutes === 60 ? "1 hour before" : `${minutes / 60} hours before`;
  return `${minutes} minutes before`;
}

function schedulePicker(deps: SetupDeps, user: UserRecord, setting: "agenda" | "lead"): Reaction {
  const buttons = new ActionButtons(deps.ids, user.id, deps.clock.now());
  const options =
    setting === "agenda"
      ? AGENDA_HOURS.map((hour) =>
          buttons.button(
            `${hour === user.agendaHour ? "✓ " : ""}${hourLabel(hour)}`,
            "set_agenda_hour",
            { hour },
          ),
        )
      : REMINDER_LEADS.map((minutes) =>
          buttons.button(
            `${minutes === user.reminderMinutes ? "✓ " : ""}${leadLabel(minutes)}`,
            "set_reminder_lead",
            { minutes },
          ),
        );
  const rows: InlineKeyboardButton[][] = [];
  for (let i = 0; i < options.length; i += 3) rows.push(options.slice(i, i + 3));
  const text =
    setting === "agenda"
      ? "When should the daily agenda arrive?"
      : "How long before timed events and exact deadlines should I remind you? Reminders set on one item stay as they are.";
  return {
    replies: [keyboardMessage(user, text, { inline_keyboard: rows }, null)],
    statements: (db, guard) => buttons.statements(db, guard),
  };
}

async function summary(deps: SetupDeps, user: UserRecord, heading: string): Promise<Reaction> {
  const lines = await settingsLines(deps, user);
  return message(
    user.privateChatId,
    `${heading}\n\n${lines.join("\n")}\n\nType what you want to add, like Dinner Fri 7pm or Buy milk, or send /help. Use /settings to change these.`,
  );
}

export async function settingsView(deps: SetupDeps, user: UserRecord): Promise<Reaction> {
  if (user.setupStep !== "done") {
    return combine(
      message(user.privateChatId, "Finish setup first."),
      await setupPrompt(deps, user),
    );
  }
  const lines = await settingsLines(deps, user);
  const buttons = new ActionButtons(deps.ids, user.id, deps.clock.now());
  const keyboard: InlineKeyboardMarkup = {
    inline_keyboard: [
      [
        buttons.button("Calendars", "open_calendars", {}),
        buttons.button("Default calendar", "open_default", {}),
      ],
      [
        buttons.button("Timezone", "open_timezone", {}),
        buttons.button("Reconnect Google", "reconnect", {}),
      ],
      [
        buttons.button("Agenda time", "open_agenda_hour", {}),
        buttons.button("Default reminder", "open_reminder_lead", {}),
      ],
      [buttons.button("Contacts", "open_contacts", {})],
    ],
  };
  return {
    replies: [keyboardMessage(user, `Settings\n\n${lines.join("\n")}`, keyboard, null)],
    statements: (db, guard) => buttons.statements(db, guard),
  };
}

export async function healthView(deps: SetupDeps, user: UserRecord): Promise<Reaction> {
  const connection = await findConnection(deps.db, user.id);
  const { results } = await deps.db
    .prepare(
      `SELECT status, COUNT(*) AS n FROM operations
       WHERE user_id = ? AND status IN ('ready', 'retry_wait', 'applying', 'needs_resolution', 'auth_required')
       GROUP BY status`,
    )
    .bind(user.id)
    .all<{ status: string; n: number }>();
  const count = (...statuses: string[]) =>
    results.filter((r) => statuses.includes(r.status)).reduce((sum, r) => sum + r.n, 0);
  const unknown = await deps.db
    .prepare("SELECT COUNT(*) AS n FROM telegram_outbox WHERE user_id = ? AND status = 'unknown'")
    .bind(user.id)
    .first<{ n: number }>();
  const sync = await syncSummary(deps.db, user.id);

  const status = !connection
    ? "Not connected"
    : connection.status === "active"
      ? `Connected (${connection.email})`
      : `Reconnection needed (${connection.email})`;
  const ttl = deps.config.testingTokenTtlDays;
  const lines = [
    `Google Calendar: ${status}`,
    ...(connection?.status === "active" && ttl !== null
      ? [`Reconnect by: ${reconnectBy(accessEndsAt(connection.connectedAt, ttl), user.timezone)}`]
      : []),
    `Last successful sync: ${describeSync(sync, deps.clock.now(), user.timezone)}`,
  ];
  if (sync.failingCalendars > 0) {
    lines.push(
      `Failed checks: ${sync.maxConsecutiveFailures} in a row (${describeError(sync.lastErrorClass)})`,
    );
  }
  lines.push(
    `Pending calendar changes: ${count("ready", "retry_wait", "applying", "auth_required")}`,
  );
  const attention = count("needs_resolution");
  if (attention > 0) lines.push(`Changes needing your attention: ${attention}`);
  if ((unknown?.n ?? 0) > 0) lines.push(`Messages that may not have arrived: ${unknown?.n}`);
  lines.push(`Scheduler: ${describeTick(await lastTickAt(deps.db), deps.clock.now())}`);

  const buttons = new ActionButtons(deps.ids, user.id, deps.clock.now());
  const row = [buttons.button(connection ? "Reauthorize" : "Connect", "reconnect", {})];
  if (connection?.status === "active" && sync.calendars > 0) {
    row.unshift(buttons.button("Force poll", "force_poll", {}));
  }
  return {
    replies: [
      keyboardMessage(user, `Health\n\n${lines.join("\n")}`, { inline_keyboard: [row] }, null),
    ],
    statements: (db, guard) => buttons.statements(db, guard),
  };
}

/** "Fri 2 Oct, 9am" (estimated: Testing-mode access lasts a fixed number of days). */
function reconnectBy(endsAt: number, timeZone: string): string {
  return formatShortStart(
    { start: { dateTime: new Date(endsAt).toISOString(), timeZone } },
    timeZone,
  );
}

function describeTick(last: number | null, now: number): string {
  if (last === null) return "not run yet";
  const minutes = Math.floor((now - last) / 60_000);
  const age = minutes < 1 ? "last run just now" : `last run ${minutes} min ago`;
  return now - last > MAX_TICK_AGE_MS ? `${age} (delayed: reminders may be late)` : age;
}

function describeSync(sync: SyncSummary, now: number, timeZone: string): string {
  if (sync.calendars === 0) return "not started (finish setup first)";
  if (sync.lastSuccessAt === null) return "in progress";
  const minutes = Math.floor((now - sync.lastSuccessAt) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  return `${formatShortStart({ start: { dateTime: new Date(sync.lastSuccessAt).toISOString(), timeZone } }, timeZone)}`;
}

function describeError(errorClass: string | null): string {
  switch (errorClass) {
    case "retryable":
      return "Google Calendar was unavailable";
    case "forbidden":
    case "not_found":
      return "a calendar is no longer accessible";
    case "auth_required":
      return "reconnection needed";
    default:
      return "an unexpected response";
  }
}

// --- Button actions ----------------------------------------------------------

/** Handles a UI button already resolved to its server-side action for this user. */
export async function handleUiAction(
  deps: SetupDeps,
  user: UserRecord,
  callback: InboundCallback,
  { action, payload }: UiAction,
): Promise<Reaction> {
  const mode: Mode = payload.mode === "settings" ? "settings" : "setup";
  const calendarId = typeof payload.calendarId === "string" ? payload.calendarId : null;
  const now = deps.clock.now();
  const ack = (text?: string) => answer(callback, text);

  switch (action) {
    case "toggle_calendar": {
      const calendars = eventCalendars(user, await listStoredCalendars(deps.db, user.id));
      const target = calendars.find((c) => c.calendarId === calendarId);
      if (!target) return ack("This calendar is no longer available.");
      const select = payload.select === true;
      const picker = await calendarPicker(
        deps,
        user,
        mode,
        callback.messageId,
        new Map([[target.calendarId, select]]),
      );
      return combine(
        ack(),
        {
          replies: [],
          statements: (db) => [
            setCalendarSelectedStatement(db, user.id, target.calendarId, select, now),
          ],
        },
        picker,
      );
    }

    case "calendars_done": {
      const selected = eventCalendars(user, await listStoredCalendars(deps.db, user.id)).filter(
        (c) => c.selected,
      );
      if (selected.length === 0) return ack("Select at least one calendar.");
      const done = combine(ack(), removeButtons(user, callback));
      if (mode === "settings") {
        return combine(
          done,
          message(
            user.privateChatId,
            `Calendars updated: ${selected.map((c) => c.summary).join(", ")}.`,
          ),
        );
      }
      return combine(done, await advance(deps, user, "calendars"));
    }

    case "choose_default": {
      const target = (await listStoredCalendars(deps.db, user.id)).find(
        (c) => c.calendarId === calendarId && c.listed,
      );
      if (!target || !isWritable(target.accessRole)) {
        return ack("You can't add events to this calendar.");
      }
      const update: Reaction = {
        replies: [],
        statements: (db, guard) => [
          setUserCalendarStatement(db, user.id, "default", target.calendarId, now, guard),
          setCalendarSelectedStatement(db, user.id, target.calendarId, true, now),
        ],
      };
      const confirmation = message(
        user.privateChatId,
        `New events go to ${target.summary} unless you name another calendar.`,
      );
      const next =
        mode === "setup"
          ? await advance(deps, user, "default", { defaultCalendarId: target.calendarId })
          : { replies: [] };
      return combine(ack(), removeButtons(user, callback), update, confirmation, next);
    }

    case "new_default":
      return combine(
        ack(),
        removeButtons(user, callback),
        askFor(deps, user, "new_default_calendar_name"),
      );

    case "use_task_calendar": {
      const target = (await listStoredCalendars(deps.db, user.id)).find(
        (c) => c.calendarId === calendarId && c.listed && c.accessRole === "owner",
      );
      if (!target) return ack("This calendar is no longer available.");
      return combine(
        ack(),
        removeButtons(user, callback),
        {
          replies: [],
          statements: (db, guard) => [
            setUserCalendarStatement(db, user.id, "task", target.calendarId, now, guard),
            setCalendarSelectedStatement(db, user.id, target.calendarId, false, now),
          ],
        },
        message(user.privateChatId, `Task deadlines will appear in ${target.summary}.`),
        await advance(deps, user, "task_calendar", { taskCalendarId: target.calendarId }),
      );
    }

    case "create_task_calendar":
      if (user.taskCalendarId) return ack("The task calendar is already set up.");
      return combine(
        ack("Creating the calendar."),
        removeButtons(user, callback),
        await proposeCalendar(
          deps,
          user,
          "task",
          TASK_CALENDAR_NAME,
          `task-calendar:${callback.data}`,
        ),
      );

    case "keep_timezone":
      return combine(
        ack(),
        removeButtons(user, callback),
        mode === "setup"
          ? await advance(deps, user, "timezone")
          : message(user.privateChatId, `Timezone unchanged: ${user.timezone}.`),
      );

    case "change_timezone":
      return combine(ack(), removeButtons(user, callback), askFor(deps, user, "timezone"));
    case "set_timezone": {
      const zone = canonicalTimezone(String(payload.zone ?? ""));
      if (!zone) return ack("This button is no longer valid.");
      return combine(ack(), removeButtons(user, callback), await applyTimezone(deps, user, zone));
    }

    case "open_calendars":
      return combine(ack(), await calendarPicker(deps, user, "settings", null));
    case "open_default":
      return combine(ack(), await defaultPicker(deps, user, "settings"));
    case "open_timezone":
      return combine(ack(), timezonePrompt(deps, user, "settings"));
    case "open_agenda_hour":
      return combine(ack(), schedulePicker(deps, user, "agenda"));
    case "open_reminder_lead":
      return combine(ack(), schedulePicker(deps, user, "lead"));
    case "set_agenda_hour": {
      const hour = Number(payload.hour);
      if (!AGENDA_HOURS.some((h) => h === hour)) return ack("This button is no longer valid.");
      return combine(ack(), removeButtons(user, callback), {
        replies: [
          {
            method: "sendMessage",
            params: {
              chat_id: user.privateChatId,
              text: `The daily agenda now arrives at ${hourLabel(hour)}. A day that already had its agenda won't get a second one.`,
            },
          },
        ],
        statements: (db) => [setScheduleSettingStatement(db, user.id, { agendaHour: hour }, now)],
      });
    }
    case "set_reminder_lead": {
      const minutes = Number(payload.minutes);
      if (!REMINDER_LEADS.some((m) => m === minutes)) return ack("This button is no longer valid.");
      return combine(ack(), removeButtons(user, callback), {
        replies: [
          {
            method: "sendMessage",
            params: {
              chat_id: user.privateChatId,
              text: `Reminders now come ${leadLabel(minutes)} timed events and exact deadlines, unless set on the item.`,
            },
          },
        ],
        statements: (db) => [
          setScheduleSettingStatement(db, user.id, { reminderMinutes: minutes }, now),
        ],
      });
    }

    case "force_poll": {
      const result = await requestForcePoll(deps.db, user.id, now);
      const text = {
        accepted: "Checking Google Calendar now. Send /health in a minute to see the result.",
        running: "A check is already running.",
        cooldown: "Google Calendar was checked moments ago. Try again in a minute.",
        not_connected: "Google Calendar isn't connected.",
      }[result];
      return ack(text);
    }

    case "open_contacts": {
      const contacts = await listContacts(deps.db, user.id);
      if (contacts.length === 0) {
        return combine(
          ack(),
          message(
            user.privateChatId,
            "No saved contacts. When you invite someone by name, I'll offer to save their address.",
          ),
        );
      }
      const buttons = new ActionButtons(deps.ids, user.id, now);
      const rows = contacts
        .slice(0, 30)
        .map((c) => [buttons.button(`Delete ${c.name}`, "contact_delete", { name: c.name })]);
      return combine(ack(), {
        replies: [
          keyboardMessage(
            user,
            `Contacts\n\n${contacts.map((c) => `• ${c.name}: ${c.email}`).join("\n")}`,
            { inline_keyboard: rows },
            null,
          ),
        ],
        statements: (db, guard) => buttons.statements(db, guard),
      });
    }

    case "contact_delete": {
      const name = String(payload.name ?? "");
      return combine(ack(`Deleted ${name}.`), {
        replies: [],
        statements: (db) => [deleteContactStatement(db, user.id, name)],
      });
    }

    case "reconnect": {
      const connection = await findConnection(deps.db, user.id);
      return combine(
        ack(),
        connectMessage(
          deps,
          user,
          connection ? "reconnect" : "connect",
          "Open this link to connect Google Calendar. It expires in 10 minutes.",
        ),
      );
    }

    case "switch_account":
      return combine(
        ack(),
        removeButtons(user, callback),
        connectMessage(
          deps,
          user,
          "replace",
          "Open this link and sign in with the account you want to use. It expires in 10 minutes.",
        ),
      );

    case "keep_account":
      return combine(
        ack(),
        removeButtons(user, callback),
        message(user.privateChatId, "Kept the connected account."),
      );

    default:
      return ack("This button is no longer valid.");
  }
}

// --- Typed answers -----------------------------------------------------------

function askFor(deps: SetupDeps, user: UserRecord, kind: PendingInputKind): Reaction {
  if (kind === "timezone") return askTimezone(deps, user);
  return guidedPrompt(deps, user, kind, {}, "Send a name for the new calendar.");
}

/** Recent zones first, then common ones, as buttons; or a typed city or Region/City. */
function askTimezone(deps: SetupDeps, user: UserRecord): Reaction {
  const buttons = new ActionButtons(deps.ids, user.id, deps.clock.now());
  const zones = [...user.recentTimezones, ...COMMON_ZONES]
    .filter((z, i, all) => z !== user.timezone && all.indexOf(z) === i)
    .slice(0, 8);
  const options = zones.map((zone) => buttons.button(zoneLabel(zone), "set_timezone", { zone }));
  const rows: InlineKeyboardButton[][] = [];
  for (let i = 0; i < options.length; i += 2) rows.push(options.slice(i, i + 2));
  return guidedPrompt(
    deps,
    user,
    "timezone",
    {},
    "Choose a timezone, or type a city or Region/City, for example London or Europe/London.",
    rows,
    buttons,
  );
}

/** Zones a typed city name is matched against. */
function knownZones(): readonly string[] {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return COMMON_ZONES;
  }
}

/** Sets the timezone (remembering the previous one), and continues setup if in it. */
async function applyTimezone(deps: SetupDeps, user: UserRecord, zone: string): Promise<Reaction> {
  const now = deps.clock.now();
  const recent = nextRecentZones(user.timezone, user.recentTimezones, zone);
  const update: Reaction = {
    replies: [],
    statements: (db) => [
      clearPendingInputStatement(db, user.id),
      setTimezoneStatement(db, user.id, zone, now, recent),
    ],
  };
  const updated = { ...user, timezone: zone, recentTimezones: recent };
  if (user.setupStep === "timezone") {
    return combine(update, await advance(deps, updated, "timezone"));
  }
  return combine(
    update,
    message(
      user.privateChatId,
      `Timezone set to ${zone}. Existing events keep their times; new dates and reminders use ${zone}.`,
    ),
  );
}

/** Handles a text message answering a pending question. */
export async function handlePendingInput(
  deps: SetupDeps,
  user: UserRecord,
  input: InboundMessage,
  kind: PendingInputKind,
): Promise<Reaction> {
  const text = (input.text ?? "").trim();
  const now = deps.clock.now();
  const clear: Reaction = {
    replies: [],
    statements: (db) => [clearPendingInputStatement(db, user.id)],
  };

  if (kind === "timezone") {
    const zone = canonicalTimezone(text);
    if (zone) return applyTimezone(deps, user, zone);
    const city = matchCity(text, knownZones());
    if (city && "zone" in city) return applyTimezone(deps, user, city.zone);
    if (city) {
      const buttons = new ActionButtons(deps.ids, user.id, now);
      const rows = city.choose.map((z) => [
        buttons.button(z.replace(/_/g, " "), "set_timezone", { zone: z }),
      ]);
      return guidedPrompt(deps, user, "timezone", {}, "Which one?", rows, buttons);
    }
    return message(
      user.privateChatId,
      "I don't recognize that timezone. Send a city, for example London, or Region/City, for example Europe/London.",
    );
  }

  // new_default_calendar_name
  if (text.length === 0 || text.length > 100 || text.startsWith("/")) {
    return message(user.privateChatId, "Send a calendar name of up to 100 characters.");
  }
  return combine(
    clear,
    await proposeCalendar(deps, user, "default", text, `default-calendar:${input.messageId}`),
  );
}

async function proposeCalendar(
  deps: SetupDeps,
  user: UserRecord,
  purpose: CreateCalendarIntent["purpose"],
  name: string,
  idempotencyKey: string,
): Promise<Reaction> {
  const known = (await listStoredCalendars(deps.db, user.id)).map((c) => c.calendarId);
  const intent: CreateCalendarIntent = {
    purpose,
    summary: name,
    timeZone: user.timezone,
    knownCalendarIds: known,
  };
  const prepared = await prepareProposal(deps, user, {
    kind: CREATE_CALENDAR,
    idempotencyKey,
    intent,
    confirmation: null,
  });
  return { replies: prepared.replies, statements: prepared.statements };
}

/** The follow-up after a calendar was created: record its role and continue setup. */
export async function calendarCreated(
  deps: SetupDeps,
  user: UserRecord,
  purpose: CreateCalendarIntent["purpose"],
  calendarId: string,
): Promise<Reaction> {
  const now = deps.clock.now();
  const update: Reaction = {
    replies: [],
    statements: (db, guard) => [
      setUserCalendarStatement(db, user.id, purpose, calendarId, now, guard),
      setCalendarSelectedStatement(db, user.id, calendarId, purpose === "default", now),
    ],
  };
  const step: SetupStep = purpose === "default" ? "default" : "task_calendar";
  const changes =
    purpose === "default" ? { defaultCalendarId: calendarId } : { taskCalendarId: calendarId };
  return combine(update, await advance(deps, user, step, changes));
}
