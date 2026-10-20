/** Response shapes of /app/api (built in src/miniapp/views.ts). */

export interface AppTask {
  id: string;
  version: number;
  title: string;
  list: { id: string; name: string };
  deadline: {
    kind: "none" | "date" | "datetime";
    date: string | null;
    at: number | null;
    time: string | null;
    label: string;
  };
  status: "open" | "completed" | "cancelled";
  overdue: boolean;
  snoozedUntil: number | null;
  snoozeLabel: string | null;
  overdueLabel: string | null;
  pending: boolean;
  seriesId: string | null;
  closedLabel?: string;
}

export interface AppEvent {
  calendarId: string;
  eventId: string;
  title: string;
  allDay: boolean;
  timeLabel: string;
  calendarName: string | null;
  link: string;
  startsAt: number | null;
  endsAt: number | null;
}

/** The user's own day and time (their zone, not the phone's). */
export interface Local {
  today: string;
  time: string;
  agendaHour: number;
}

export interface ListSummary {
  id: string;
  name: string;
}

export interface Home {
  date: string;
  label: string;
  heading: string;
  local: Local;
  nextUp: string | null;
  next: {
    kind: "event" | "task";
    time: string;
    title: string;
    when: string;
    link?: string;
    taskId?: string;
    startsAt: number;
    until: string | null;
    since: number;
  } | null;
  calendarClear: boolean;
  tiles: {
    /** Open tasks due today; `done` are those already completed; `left` is what's still ahead. */
    today: { events: number; tasks: number; done: number; left: number };
    overdue: number;
    overdueOldestDays: number | null;
    week: number;
    weekDays: { date: string; letter: string; today: boolean; count: number }[];
    noDeadline: number;
  };
  allClear: boolean;
  lists: { id: string; name: string; open: number; overdue: number; inbox: boolean }[];
  recent: number;
  sync: string;
  reconnect: boolean;
  tomorrowLabel: string;
}

export interface Today {
  date: string;
  label: string;
  local: Local;
  live: boolean;
  allDay: AppEvent[];
  timed: AppEvent[];
  overdue: AppTask[];
  due: AppTask[];
  openEnded: number;
  tomorrowLabel: string;
}

export interface Week {
  start: string;
  label: string;
  local: Local;
  previous: string;
  next: string;
  live: boolean;
  days: { date: string; label: string; today: boolean; events: AppEvent[]; tasks: AppTask[] }[];
}

export interface TaskSet {
  title: string;
  showList: boolean;
  listId: string | null;
  local: Local;
  /** How each series shown repeats, by series ID. */
  series: Record<string, string>;
  tomorrowLabel: string;
  tasks: AppTask[];
  lists: ListSummary[];
}

/** One item's reminders (ADR 0008); writes carry `version`. */
export interface ReminderPanel {
  version: number;
  custom: boolean;
  timed: boolean;
  items: { code: string; label: string }[];
  presets: { code: string; label: string; on: boolean }[];
  summary: string;
  max: number;
}

export type ReminderTarget =
  | { kind: "task"; taskId: string }
  | { kind: "event"; calendarId: string; eventId: string };

export interface EventReminders {
  title: string;
  when: string;
  target: ReminderTarget;
  reminders: ReminderPanel;
}

export interface TaskDetail {
  task: AppTask;
  local: Local;
  /** Null without a deadline, or when the task isn't open. */
  reminders: ReminderPanel | null;
  repeat: { seriesId: string; version: number; label: string; active: boolean } | null;
  workTime: string[];
  tomorrowLabel: string;
  history: string[];
  lists: ListSummary[];
}

export interface Recent {
  days: number;
  tasks: AppTask[];
}
