import type { Clock } from "../shared/clock";
import { logEvent } from "../shared/log";
import type { TelegramClient } from "../telegram/client";
import { BOT_COMMANDS, commandsFingerprint } from "../telegram/commands";

const STATE_KEY = "telegram_commands";

export interface BotCommandDeps {
  db: D1Database;
  clock: Clock;
  telegram: TelegramClient;
}

/**
 * Registers the command menu with Telegram when the list changed since the last
 * successful registration. Costs one D1 read per tick otherwise; a failure is
 * retried on the next tick.
 */
export async function syncBotCommands(deps: BotCommandDeps): Promise<boolean> {
  const fingerprint = commandsFingerprint();
  const stored = await deps.db
    .prepare("SELECT value FROM app_state WHERE key = ?")
    .bind(STATE_KEY)
    .first<{ value: string }>();
  if (stored?.value === fingerprint) return false;

  const commands = await deps.telegram.call({
    method: "setMyCommands",
    params: {
      commands: BOT_COMMANDS.map(({ command, description }) => ({ command, description })),
      scope: { type: "all_private_chats" },
    },
  });
  if (commands.kind !== "ok") {
    logEvent("bot_commands.failed", { step: "commands", errorClass: commands.errorClass });
    return false;
  }
  const menu = await deps.telegram.call({
    method: "setChatMenuButton",
    params: { menu_button: { type: "commands" } },
  });
  if (menu.kind !== "ok") {
    logEvent("bot_commands.failed", { step: "menu_button", errorClass: menu.errorClass });
    return false;
  }
  await deps.db
    .prepare(
      `INSERT INTO app_state (key, value, updated_at) VALUES (?1, ?2, ?3)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(STATE_KEY, fingerprint, deps.clock.now())
    .run();
  logEvent("bot_commands.registered", { count: BOT_COMMANDS.length });
  return true;
}
