import { isWritable } from "../calendar/port";
import type { AppConfig } from "../env";
import { requestForcePoll, type SyncSummary, syncSummary } from "../jobs/calendar-sync";
import type { Clock } from "../shared/clock";
import type { IdGenerator } from "../shared/ids";
import {
  findConnection,
  listStoredCalendars,
  type StoredCalendar,
  setCalendarSelectedStatement,
} from "../storage/google";
import {
  clearPendingInputStatement,
  type PendingInputKind,
  setPendingInputStatement,
  type UiAction,
} from "../storage/interactions";
import {
  advanceSetupStatement,
  type SetupStep,
  setTimezoneStatement,
  setUserCalendarStatement,
  type UserRecord,
} from "../storage/users";
import type { InlineKeyboardButton, InlineKeyboardMarkup } from "../telegram/api";
import { formatShortStart } from "../telegram/format";
import { TAGLINE } from "../telegram/messages";
import type { InboundCallback, InboundMessage } from "../telegram/update";
import { CREATE_CALENDAR, type CreateCalendarIntent } from "./calendar-operations";
import { connectMessage } from "./google-connection";
import { prepareProposal } from "./proposals";
import { ActionButtons, combine, message, type Reaction } from "./reactions";
import { answer, keyboardMessage, removeButtons } from "./ui";

export const TASK_CALENDAR_NAME = "Tasks - Oh My Days";
export const PENDING_INPUT_TTL_MS = 10 * 60_000;
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
  const next = await setupPrompt(deps, { ...user, ...changes, setupStep: to });
  return combine(
    {
      replies: [],
      statements: (db, guard) => [advanceSetupStatement(db, user.id, from, to, now, guard)],
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
  ];
}

async function summary(deps: SetupDeps, user: UserRecord, heading: string): Promise<Reaction> {
  const lines = await settingsLines(deps, user);
  return message(
    user.privateChatId,
    `${heading}\n\n${lines.join("\n")}\n\nAdding events and tasks arrives in a later update. Use /settings to change these.`,
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
  const lines = [
    `Google Calendar: ${status}`,
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

    case "open_calendars":
      return combine(ack(), await calendarPicker(deps, user, "settings", null));
    case "open_default":
      return combine(ack(), await defaultPicker(deps, user, "settings"));
    case "open_timezone":
      return combine(ack(), timezonePrompt(deps, user, "settings"));

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
  const now = deps.clock.now();
  const prompt =
    kind === "timezone"
      ? "Send your timezone as Region/City, for example Europe/London."
      : "Send a name for the new calendar.";
  return combine(
    {
      replies: [],
      statements: (db) => [
        setPendingInputStatement(db, user.id, kind, now + PENDING_INPUT_TTL_MS, now),
      ],
    },
    message(user.privateChatId, prompt),
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
    if (!zone) {
      return message(
        user.privateChatId,
        "I don't recognize that timezone. Send it as Region/City, for example Europe/London.",
      );
    }
    const update: Reaction = {
      replies: [],
      statements: (db) => [setTimezoneStatement(db, user.id, zone, now)],
    };
    const updated = { ...user, timezone: zone };
    if (user.setupStep === "timezone") {
      return combine(clear, update, await advance(deps, updated, "timezone"));
    }
    return combine(
      clear,
      update,
      message(
        user.privateChatId,
        `Timezone set to ${zone}. Existing events keep their times; new dates and reminders use ${zone}.`,
      ),
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
