import { describe, expect, it } from "vitest";
import { ConfigError, type Env, readConfig } from "../src/env";

const base: Env = {
  DB: {} as D1Database,
  TELEGRAM_BOT_TOKEN: "test-bot-token",
  TELEGRAM_WEBHOOK_SECRET: "test-webhook-secret",
  TELEGRAM_ALLOWED_USER_IDS: "1001",
  TELEGRAM_BOT_USERNAME: "oh_my_days_bot",
  PUBLIC_BASE_URL: "https://ohmydays.test",
  GOOGLE_CLIENT_ID: "id",
  GOOGLE_CLIENT_SECRET: "secret",
  TOKEN_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
};

describe("TESTING_TOKEN_TTL_DAYS", () => {
  it("is off unless set", () => {
    expect(readConfig(base).testingTokenTtlDays).toBeNull();
    expect(readConfig({ ...base, TESTING_TOKEN_TTL_DAYS: "" }).testingTokenTtlDays).toBeNull();
  });

  it("accepts whole days", () => {
    expect(readConfig({ ...base, TESTING_TOKEN_TTL_DAYS: "7" }).testingTokenTtlDays).toBe(7);
  });

  it.each(["0", "1", "7.5", "seven", "400"])("refuses %s", (value) => {
    expect(() => readConfig({ ...base, TESTING_TOKEN_TTL_DAYS: value })).toThrow(ConfigError);
  });
});
