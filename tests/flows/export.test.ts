import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { isReplaySafe } from "../../src/telegram/api";
import { rows } from "../support/db";
import { OTHER_USER } from "../support/fakes";
import { ownerCalendar, PRIMARY, setUpOwner, World } from "../support/world";

// World time starts at Fri 25 Sep 2026, 09:00 in Singapore. Synthetic data only.

function exported(world: World) {
  const call = [...world.telegram.calls].reverse().find((c) => c.method === "sendDocument");
  if (call?.method !== "sendDocument") throw new Error("no document sent");
  return { params: call.params, data: JSON.parse(call.params.document.content) };
}

describe("/export (D6)", () => {
  it("sends the user's tasks, lists, series, and contacts as one JSON file", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    ownerCalendar(world).seed(PRIMARY.calendarId, "secret", {
      summary: "Private appointment",
      start: { date: "2026-09-26" },
      end: { date: "2026-09-27" },
    });
    await world.tick();
    await world.send("Buy milk");
    await world.send("Pay rent by tomorrow");
    await world.send("/tasks");
    await world.press(/Buy milk/);
    await world.press("Done");
    await world.send("/task");
    await world.press("New task");
    await world.send("Water plants");
    await world.press("Today · Fri 25 Sep");
    await world.press("Any time that day");
    await world.press("Weekly");
    const [user] = await rows<{ id: string }>(
      env.DB,
      "SELECT id FROM users WHERE setup_step = 'done'",
    );
    await env.DB.prepare(
      "INSERT INTO contacts (user_id, normalized_name, name, email, created_at) VALUES (?, 'sam', 'Sam', 'sam@example.com', 0)",
    )
      .bind(user?.id)
      .run();

    await world.send("/export");
    const { params, data } = exported(world);
    expect(params.document.filename).toBe("oh-my-days-export-2026-09-25.json");
    expect(params.document.mime_type).toBe("application/json");
    expect(data).toMatchObject({
      format: "oh-my-days-export",
      version: 1,
      timezone: "Asia/Singapore",
      lists: [{ name: "Inbox", inbox: true }],
      contacts: [{ name: "Sam", email: "sam@example.com" }],
      series: [{ title: "Water plants", repeat: { freq: "weekly", interval: 1, by: null } }],
    });
    const byTitle = Object.fromEntries(
      (data.tasks as { title: string }[]).map((t) => [t.title, t]),
    );
    expect(byTitle["Buy milk"]).toMatchObject({ status: "completed", deadline: null });
    expect(byTitle["Pay rent"]).toMatchObject({ status: "open", deadline: { date: "2026-09-26" } });
    expect(byTitle["Water plants"]).toMatchObject({ occurrence: "2026-09-25" });

    const text = params.document.content;
    expect(text).not.toContain("Private appointment"); // no copy of calendar events
    expect(text).not.toMatch(/token|refresh|owner@example\.com/i); // no Google credentials or account
  });

  it("never includes another user's data", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await world.send("/start", OTHER_USER);
    const [other] = await rows<{ id: string }>(
      env.DB,
      "SELECT id FROM users WHERE telegram_user_id = ?",
      OTHER_USER,
    );
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO task_lists (id, user_id, name, normalized_name, is_inbox, created_at, updated_at) VALUES ('ol', ?, 'Other inbox', 'other inbox', 1, 0, 0)",
      ).bind(other?.id),
      env.DB.prepare(
        "INSERT INTO tasks (id, user_id, list_id, title, due_kind, status, origin, created_at, updated_at) VALUES ('ot', ?, 'ol', 'Secret errand', 'none', 'open', 'telegram', 0, 0)",
      ).bind(other?.id),
      env.DB.prepare(
        "INSERT INTO contacts (user_id, normalized_name, name, email, created_at) VALUES (?, 'x', 'X', 'x@example.com', 0)",
      ).bind(other?.id),
    ]);
    await world.send("/export");
    const text = exported(world).params.document.content;
    expect(text).not.toContain("Secret errand");
    expect(text).not.toContain("x@example.com");
    expect(text).not.toContain("Other inbox");
  });

  it("is never re-sent automatically after an unknown outcome", () => {
    expect(isReplaySafe("sendDocument")).toBe(false);
  });
});
