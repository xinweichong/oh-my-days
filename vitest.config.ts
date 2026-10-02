import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
      return {
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          // Synthetic test configuration only; never real credentials.
          bindings: {
            TEST_MIGRATIONS: migrations,
            TELEGRAM_BOT_TOKEN: "test-bot-token",
            TELEGRAM_WEBHOOK_SECRET: "test-webhook-secret",
            TELEGRAM_ALLOWED_USER_IDS: "1001,1002",
            PUBLIC_BASE_URL: "https://ohmydays.test",
            GOOGLE_CLIENT_ID: "test-client.apps.googleusercontent.com",
            GOOGLE_CLIENT_SECRET: "test-client-secret",
            // 32 zero bytes: a synthetic key for tests only.
            TOKEN_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
          },
        },
      };
    }),
  ],
  test: {
    setupFiles: ["./tests/setup/apply-migrations.ts"],
  },
});
