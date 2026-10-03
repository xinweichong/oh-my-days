/** Worker bindings. Secrets come from Worker secrets or a local, ignored .dev.vars file. */
export interface Env {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  TELEGRAM_ALLOWED_USER_IDS: string;
  /** Bot username without @, used for "Continue in Telegram" links. */
  TELEGRAM_BOT_USERNAME: string;
  /** Origin the Worker is reached at, e.g. https://ohmydays.xinweichong.com. */
  PUBLIC_BASE_URL: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  /** Base64 32-byte AES-256-GCM key for stored Google tokens. Never stored in D1. */
  TOKEN_ENCRYPTION_KEY: string;
  /** Optional contact address shown in the privacy policy. */
  CONTACT_EMAIL?: string;
}

export interface AppConfig {
  telegramBotToken: string;
  telegramWebhookSecret: string;
  allowedTelegramUserIds: ReadonlySet<number>;
  telegramBotUsername: string;
  publicBaseUrl: string;
  googleClientId: string;
  googleClientSecret: string;
  tokenEncryptionKey: string;
  contactEmail: string | null;
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
  for (const name of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"] as const) {
    if (!env[name]) throw new ConfigError(`${name} is not configured`);
  }
  if (!isAes256Key(env.TOKEN_ENCRYPTION_KEY ?? "")) {
    throw new ConfigError("TOKEN_ENCRYPTION_KEY must be 32 random bytes, base64-encoded");
  }
  if (!/^[A-Za-z0-9_]{5,32}$/.test(env.TELEGRAM_BOT_USERNAME ?? "")) {
    throw new ConfigError("TELEGRAM_BOT_USERNAME must be the bot username without @");
  }
  return {
    telegramBotToken: env.TELEGRAM_BOT_TOKEN,
    telegramWebhookSecret: env.TELEGRAM_WEBHOOK_SECRET,
    allowedTelegramUserIds: parseAllowlist(env.TELEGRAM_ALLOWED_USER_IDS ?? ""),
    telegramBotUsername: env.TELEGRAM_BOT_USERNAME,
    publicBaseUrl: parseBaseUrl(env.PUBLIC_BASE_URL ?? ""),
    googleClientId: env.GOOGLE_CLIENT_ID,
    googleClientSecret: env.GOOGLE_CLIENT_SECRET,
    tokenEncryptionKey: env.TOKEN_ENCRYPTION_KEY,
    contactEmail: env.CONTACT_EMAIL?.includes("@") ? env.CONTACT_EMAIL : null,
  };
}

/** HTTPS origins only, except plain-HTTP localhost for development. */
export function parseBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError("PUBLIC_BASE_URL must be an absolute URL");
  }
  const local = url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname);
  if ((url.protocol !== "https:" && !local) || url.pathname !== "/" || url.search || url.hash) {
    throw new ConfigError("PUBLIC_BASE_URL must be an https origin (or http://localhost)");
  }
  return url.origin;
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

function isAes256Key(value: string): boolean {
  try {
    return atob(value.trim()).length === 32;
  } catch {
    return false;
  }
}
