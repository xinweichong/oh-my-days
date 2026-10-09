import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { capture } from "../../src/domain/capture";
import { parseFollowUp } from "../../src/domain/follow-up";
import { helpText } from "../../src/telegram/messages";
import { setUpOwner, World } from "../support/world";

// World time starts at Fri 25 Sep 2026, 09:00 in Singapore.

describe("/help", () => {
  it("leads with typed examples, then commands", () => {
    const lines = helpText().split("\n");
    expect(lines.slice(0, 4)).toEqual([
      "Type what you want to add, for example:",
      "Dinner Fri 7pm",
      "Buy milk",
      "Pay rent by 1 Nov",
    ]);
    expect(lines.indexOf("Commands:")).toBeGreaterThan(lines.indexOf("done"));
  });

  it("shows only examples the bot understands", () => {
    const ctx = { today: "2026-10-07", lists: [], calendars: [] };
    for (const example of ["Dinner Fri 7pm", "Buy milk", "Pay rent by 1 Nov"]) {
      expect(capture(example, ctx).kind, example).toBe("create");
    }
    for (const followUp of ["move it to 4pm", "done"]) {
      expect(parseFollowUp(followUp, ctx.today), followUp).not.toBeNull();
    }
  });
});

describe("typing hints after guided creations", () => {
  async function guidedTask(world: World, title: string) {
    await world.send("/task");
    await world.press("New task");
    await world.send(title);
    await world.press("No deadline");
  }

  it("adds one hint line to each of the first three guided creations only", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await env.DB.prepare("UPDATE users SET typing_hints_shown = 0").run();
    await guidedTask(world, "One");
    expect(world.lastText()).toBe(
      "Task added to Inbox: One.\nNo deadline.\n\nNext time you can type: Pay rent by 1 Nov",
    );
    await world.send("/event");
    await world.press("New event");
    await world.send("Two");
    await world.press("Tomorrow · Sat 26 Sep");
    await world.send("7pm");
    await world.press("1 hour");
    await world.press("Doesn't repeat");
    expect(world.lastText()).toBe(
      "Event added: Two\nSat 26 Sep 2026, 7–8pm · owner@example.com\n\nNext time you can type: Dinner Fri 7pm",
    );
    // Typed creations don't use up hints.
    await world.send("Typed task");
    expect(world.lastText()).toBe("Task added to Inbox: Typed task.\nNo deadline.");
    await guidedTask(world, "Three");
    expect(world.lastText()).toContain("Next time you can type:");
    await guidedTask(world, "Four");
    expect(world.lastText()).toBe("Task added to Inbox: Four.\nNo deadline.");
  });
});
