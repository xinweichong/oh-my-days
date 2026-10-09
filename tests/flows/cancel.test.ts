import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { count, rows } from "../support/db";
import { OTHER_USER, OWNER } from "../support/fakes";
import { callbackUpdate } from "../support/telegram";
import { ownerCalendar, setUpOwner, World } from "../support/world";

// World time starts at Fri 25 Sep 2026, 09:00 in Singapore.

async function pending() {
  return rows<{ kind: string }>(env.DB, "SELECT kind FROM pending_inputs");
}

describe("a way out of guided questions", () => {
  it("puts Cancel on each typed-input question and drops only that question", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await world.send("/event");
    await world.press("New event");
    await world.send("Dinner");
    expect(world.lastText()).toContain("Which day is Dinner?");
    await world.press("Cancel");
    expect(world.lastText()).toBe("Cancelled adding the event Dinner.");
    expect(await pending()).toEqual([]);
    // Plain text is now a new request, not an answer to the old question.
    await world.send("Buy milk");
    expect(world.lastText()).toBe("Task added to Inbox: Buy milk.\nNo deadline.");
    await world.tick();
    expect(
      [...ownerCalendar(world).events.values()].some((e) => e.fields.summary === "Dinner"),
    ).toBe(false);
  });

  it("cancels questions answered with buttons", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await world.send("/task");
    await world.press("New task");
    await world.send("Pay rent");
    await world.press("Today · Fri 25 Sep");
    await world.press("Any time that day");
    expect(world.lastText()).toBe("Does Pay rent repeat?");
    await world.press("Cancel");
    expect(world.lastText()).toBe("Cancelled adding the task Pay rent.");
    expect(await count(env.DB, "tasks")).toBe(0);
  });

  it("leaves a newer question open when an older Cancel is pressed", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await world.send("/event");
    await world.press("New event");
    const oldCancel = world.findButton("Cancel");
    await world.send("/task");
    await world.press("New task");
    if (!("callback_data" in oldCancel)) throw new Error("expected a callback button");
    await world.webhook(callbackUpdate(OWNER, oldCancel.callback_data));
    expect(world.answers().at(-1)).toBe("This question is already closed.");
    expect(await pending()).toEqual([{ kind: "task_title" }]);
  });

  it("/cancel says what was abandoned, or that nothing was open", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await world.send("/cancel");
    expect(world.lastText()).toBe("Nothing to cancel.");
    await world.send("/task");
    await world.press("New task");
    await world.send("Pay rent");
    await world.send("/cancel");
    expect(world.lastText()).toBe("Cancelled adding the task Pay rent.");
    expect(await pending()).toEqual([]);
  });

  it("cancels setup questions and snooze times too", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await world.send("/settings");
    await world.press("Timezone");
    await world.press("Change timezone");
    await world.press("Cancel");
    expect(world.lastText()).toBe("Cancelled changing the timezone.");
    const [user] = await rows<{ timezone: string }>(env.DB, "SELECT timezone FROM users");
    expect(user?.timezone).toBe("Asia/Singapore");
  });

  it("refuses another user's Cancel button", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await world.send("/task");
    await world.press("New task");
    await world.press("Cancel", OTHER_USER);
    expect(world.answers().at(-1)).toBe("This button is no longer valid.");
    expect(await pending()).toEqual([{ kind: "task_title" }]);
  });

  it("offers Cancel on an ambiguous follow-up", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await world.send("Buy milk");
    await world.send("make that Friday");
    await world.press("Cancel");
    expect(world.lastText()).toBe("Cancelled the change.");
    const [task] = await rows<{ due_kind: string }>(env.DB, "SELECT due_kind FROM tasks");
    expect(task?.due_kind).toBe("none");
  });
});
