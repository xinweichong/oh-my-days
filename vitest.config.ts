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
          },
        },
      };
    }),
  ],
  test: {
    setupFiles: ["./tests/setup/apply-migrations.ts"],
  },
});
