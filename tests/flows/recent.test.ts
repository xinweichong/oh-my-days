import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { rows } from "../support/db";
import { OTHER_USER } from "../support/fakes";
import { ownerCalendar, setUpOwner, World } from "../support/world";

// World time starts at Fri 25 Sep 2026, 09:00 in Singapore.
const DAY = 24 * 60 * 60_000;

async function close(world: World, title: string, how: "Done" | "Cancel task") {
  await world.send("/tasks");
  await world.press(new RegExp(title));
  await world.press(how);
  if (how === "Cancel task") await world.press("Cancel task");
}

function markers(world: World, title: string) {
  return [...ownerCalendar(world).events.values()].filter(
    (e) => e.status !== "cancelled" && e.fields.summary.endsWith(title),
  );
}

describe("/tasks Recent (C5)", () => {
  it("lists completed and cancelled tasks, and restores one with its deadline marker", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await world.send("Buy milk");
    await world.send("Pay rent by tomorrow");
    await world.send("Open one");
    await close(world, "Buy milk", "Done");
    world.clock.advance(60_000);
    await close(world, "Pay rent", "Cancel task");
    await world.tick();
    expect(markers(world, "Pay rent")).toHaveLength(0);

    await world.send("/tasks");
    await world.press("Recent");
    expect(world.lastText()).toBe("Completed and cancelled, last 30 days: 2");
    expect(world.findButton("Done Fri 25 Sep · [Inbox] Buy milk")).toBeTruthy();
    await world.press("Cancelled Fri 25 Sep · [Inbox] Pay rent · Sat 26 Sep");
    await world.press("Restore");
    expect(world.lastText()).toBe("Reopened: Pay rent.");
    await world.tick();
    expect(markers(world, "Pay rent")).toHaveLength(1);
  });

  it("goes back 30 days only", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await world.send("Buy milk");
    await close(world, "Buy milk", "Done");
    world.clock.advance(31 * DAY);
    await world.send("/tasks");
    await world.press("Recent");
    expect(world.lastText()).toBe("Nothing completed or cancelled in the last 30 days.");
  });

  it("never lists another user's tasks", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await world.send("/start", OTHER_USER);
    const [other] = await rows<{ id: string }>(
      env.DB,
      "SELECT id FROM users WHERE telegram_user_id = ?",
      OTHER_USER,
    );
    const now = world.clock.now();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO task_lists (id, user_id, name, normalized_name, is_inbox, created_at, updated_at) VALUES ('ol', ?, 'Inbox', 'inbox', 1, ?, ?)",
      ).bind(other?.id, now, now),
      env.DB.prepare(
        "INSERT INTO tasks (id, user_id, list_id, title, due_kind, status, completed_at, origin, created_at, updated_at) VALUES ('ot', ?, 'ol', 'Secret errand', 'none', 'completed', ?, 'telegram', ?, ?)",
      ).bind(other?.id, now, now, now),
    ]);
    await world.send("/tasks");
    await world.press("Recent");
    expect(world.lastText()).toBe("Nothing completed or cancelled in the last 30 days.");
  });
});
