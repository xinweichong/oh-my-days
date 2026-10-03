/**
 * The bot's commands, defined once for both /help and Telegram's command menu.
 * List only commands that work; later stages add entries as features ship.
 */
export interface BotCommand {
  /** 1-32 characters of a-z, 0-9, and _ (Telegram's limit). */
  command: string;
  /** Shown in Telegram's menu; 1-256 characters. */
  description: string;
}

export const BOT_COMMANDS: readonly BotCommand[] = [
  { command: "start", description: "Introduction, or continue setup" },
  { command: "event", description: "Add, rename, move, or delete an event" },
  { command: "task", description: "Add a task, or manage lists" },
  { command: "tasks", description: "Open tasks, by list, with actions" },
  { command: "daily", description: "Today's events, due and overdue tasks" },
  { command: "weekly", description: "This week, Monday to Sunday" },
  { command: "monthly", description: "This month, compactly" },
  { command: "calendars", description: "One calendar's week" },
  { command: "overdue", description: "Unfinished tasks past their deadline" },
  { command: "reminders", description: "Upcoming and snoozed reminders" },
  { command: "settings", description: "Calendars, default calendar, and timezone" },
  { command: "health", description: "Google Calendar connection status" },
  { command: "help", description: "Available commands" },
];

/** Changes whenever the menu should be registered again. */
export function commandsFingerprint(commands: readonly BotCommand[] = BOT_COMMANDS): string {
  return JSON.stringify(commands.map((c) => [c.command, c.description]));
}
