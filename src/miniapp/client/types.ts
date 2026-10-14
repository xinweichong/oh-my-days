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
}

export interface ListSummary {
  id: string;
  name: string;
}

export interface Home {
  date: string;
  label: string;
  heading: string;
  nextUp: string | null;
  next: {
    kind: "event" | "task";
    time: string;
    title: string;
    when: string;
    link?: string;
    taskId?: string;
  } | null;
  calendarClear: boolean;
  tiles: {
    today: { events: number; tasks: number };
    overdue: number;
    week: number;
    noDeadline: number;
  };
  lists: { id: string; name: string; open: number; inbox: boolean }[];
  recent: number;
  sync: string;
  reconnect: boolean;
  tomorrowLabel: string;
}

export interface Today {
  date: string;
  label: string;
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
  previous: string;
  next: string;
  live: boolean;
  days: { date: string; label: string; today: boolean; events: AppEvent[]; tasks: AppTask[] }[];
}

export interface TaskSet {
  title: string;
  showList: boolean;
  listId: string | null;
  tomorrowLabel: string;
  tasks: AppTask[];
  lists: ListSummary[];
}

export interface TaskDetail {
  task: AppTask;
  reminder: string | null;
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
