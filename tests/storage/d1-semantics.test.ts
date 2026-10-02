import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { count } from "../support/db";

/**
 * Pins the D1 behaviours the storage design relies on (backend plan §4:
 * "verify actual D1 transaction semantics"). Local Miniflare evidence only.
 */
describe("D1 batch semantics", () => {
  async function seedUser(id: string, telegramId: number): Promise<D1PreparedStatement> {
    return env.DB.prepare(
      "INSERT INTO users (id, telegram_user_id, private_chat_id, created_at, updated_at) VALUES (?, ?, ?, 0, 0)",
    ).bind(id, telegramId, telegramId);
  }

  it("rolls back every statement when one statement in a batch fails", async () => {
    await expect(
      env.DB.batch([await seedUser("u1", 1), await seedUser("u2", 1)]), // duplicate telegram ID
    ).rejects.toThrow();
    expect(await count(env.DB, "users")).toBe(0);
  });

  it("lets later statements observe earlier writes in the same batch", async () => {
    const results = await env.DB.batch([
      await seedUser("u1", 1),
      env.DB.prepare("UPDATE users SET timezone = 'Europe/London' WHERE id = 'u1'"),
    ]);
    expect(results[1]?.meta.changes).toBe(1);
  });

  it("reports zero changes for a guarded statement whose guard fails", async () => {
    await env.DB.batch([await seedUser("u1", 1)]);
    const result = await env.DB.prepare(
      "UPDATE users SET timezone = 'Europe/London' WHERE id = 'u1' AND EXISTS (SELECT 1 FROM users WHERE id = 'missing')",
    ).run();
    expect(result.meta.changes).toBe(0);
  });

  it("enforces foreign keys", async () => {
    await expect(
      env.DB.prepare(
        "INSERT INTO telegram_inbox (update_id, user_id, kind, payload, status, received_at) VALUES (1, 'nobody', 'message', '{}', 'pending', 0)",
      ).run(),
    ).rejects.toThrow();
  });
});
