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
      env.DB.prepare("UPDATE users SET status = 'disabled' WHERE id = 'u1'"),
    ]);
    expect(results[1]?.meta.changes).toBe(1);
  });

  it("counts rows changed by triggers in meta.changes (ADR 0004)", async () => {
    // Changing a timezone also clears next_due_at by trigger: two rows changed.
    // Guards that test `changes === 1` must target tables without triggers.
    await env.DB.batch([await seedUser("u1", 1)]);
    const result = await env.DB.prepare(
      "UPDATE users SET timezone = 'Europe/London' WHERE id = 'u1'",
    ).run();
    expect(result.meta.changes).toBe(2);
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

describe("telegram_outbox after its rebuild (migration 0021)", () => {
  it("keeps its indexes and constraints, and accepts documents", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'telegram_outbox' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all<{ name: string }>();
    expect(results.map((r) => r.name)).toEqual([
      "telegram_outbox_reply",
      "telegram_outbox_status_due",
      "telegram_outbox_user_status",
    ]);
    await env.DB.prepare(
      "INSERT INTO users (id, telegram_user_id, private_chat_id, created_at, updated_at) VALUES ('u1', 1, 1, 0, 0)",
    ).run();
    const insert = (method: string) =>
      env.DB.prepare(
        `INSERT INTO telegram_outbox (id, user_id, logical_key, method, payload, status, due_at, created_at, updated_at, target)
         VALUES (?, 'u1', ?, ?, '{}', 'pending', 0, 0, 0, NULL)`,
      )
        .bind(method, method, method)
        .run();
    await insert("sendDocument");
    await expect(insert("deleteMessage")).rejects.toThrow();
    // Sent rows still drop their payload.
    await expect(
      env.DB.prepare("UPDATE telegram_outbox SET status = 'sent' WHERE id = 'sendDocument'").run(),
    ).rejects.toThrow();
  });
});
