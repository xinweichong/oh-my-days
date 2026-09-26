/** Worker bindings. Secrets come from Worker secrets or a local, ignored .dev.vars file. */
export interface Env {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  TELEGRAM_ALLOWED_USER_IDS: string;
}

export interface AppConfig {
  telegramBotToken: string;
  telegramWebhookSecret: string;
  allowedTelegramUserIds: ReadonlySet<number>;
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

const WEBHOOK_SECRET_PATTERN = /^[A-Za-z0-9_-]{16,256}$/;

/** Validates configuration without echoing secret values in errors. */
export function readConfig(env: Env): AppConfig {
  if (!env.TELEGRAM_BOT_TOKEN) {
    throw new ConfigError("TELEGRAM_BOT_TOKEN is not configured");
  }
  if (!WEBHOOK_SECRET_PATTERN.test(env.TELEGRAM_WEBHOOK_SECRET ?? "")) {
    throw new ConfigError(
      "TELEGRAM_WEBHOOK_SECRET must be 16-256 characters of A-Z, a-z, 0-9, _ or -",
    );
  }
  return {
    telegramBotToken: env.TELEGRAM_BOT_TOKEN,
    telegramWebhookSecret: env.TELEGRAM_WEBHOOK_SECRET,
    allowedTelegramUserIds: parseAllowlist(env.TELEGRAM_ALLOWED_USER_IDS ?? ""),
  };
}

export function parseAllowlist(value: string): ReadonlySet<number> {
  const ids = new Set<number>();
  for (const part of value.split(",")) {
    const trimmed = part.trim();
    if (trimmed === "") continue;
    if (!/^[1-9][0-9]{0,15}$/.test(trimmed) || !Number.isSafeInteger(Number(trimmed))) {
      throw new ConfigError("TELEGRAM_ALLOWED_USER_IDS must contain numeric Telegram user IDs");
    }
    ids.add(Number(trimmed));
  }
  return ids;
}
