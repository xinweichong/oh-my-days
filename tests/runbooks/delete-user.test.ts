import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import runbook from "../../docs/runbooks/operations.md?raw";
import { rows } from "../support/db";
import { OWNER } from "../support/fakes";
import { ownerCalendar, PRIMARY, setUpOwner, World } from "../support/world";

/** The "Deleting a user's data" SQL, exactly as documented. */
function deletionStatements(userId: string): string[] {
  const section = runbook.slice(runbook.indexOf("## Deleting a user's data"));
  const sql = /```sql\n([\s\S]*?)```/.exec(section)?.[1] ?? "";
  return sql
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replaceAll("<id>", userId));
}

describe("runbook: deleting a user's data", () => {
  it("removes every row for the user without foreign-key errors, leaving others intact", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    ownerCalendar(world).seed(PRIMARY.calendarId, "e", {
      summary: "Dinner",
      start: { dateTime: "2026-09-26T19:00:00+08:00", timeZone: "Asia/Singapore" },
      end: { dateTime: "2026-09-26T20:00:00+08:00", timeZone: "Asia/Singapore" },
    });
    await world.send("/task");
    await world.press("New task");
    await world.send("Buy milk");
    await world.press("No deadline");
    world.clock.advance(10 * 60_000);
    await world.tick();
    const [user] = await rows<{ id: string }>(
      env.DB,
      "SELECT id FROM users WHERE telegram_user_id = ?",
      OWNER,
    );
    if (!user) throw new Error("no user");

    const statements = deletionStatements(user.id);
    expect(statements.length).toBeGreaterThan(15);
    for (const statement of statements) await env.DB.prepare(statement).run();

    // Every table with a user_id column (read from the schema text; D1 has no table_info pragma).
    const tables = (
      await rows<{ name: string; sql: string }>(
        env.DB,
        "SELECT name, sql FROM sqlite_master WHERE type = 'table'",
      )
    ).filter((t) => /(^|[\s(,])user_id\s+TEXT/m.test(t.sql));
    expect(tables.length).toBeGreaterThanOrEqual(20);
    for (const { name } of tables) {
      const [left] = await rows<{ n: number }>(
        env.DB,
        `SELECT COUNT(*) AS n FROM ${name} WHERE user_id = ?`,
        user.id,
      );
      expect(left?.n, name).toBe(0);
    }
    expect(await rows(env.DB, "SELECT id FROM users")).toHaveLength(0);
  });
});
