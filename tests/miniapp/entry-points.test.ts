import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { count } from "../support/db";
import { testConfig } from "../support/fakes";
import { setUpOwner, World } from "../support/world";

// World time starts at Fri 25 Sep 2026, 09:00 in Singapore.
const APP = "https://ohmydays.test/app";

describe("opening the Mini App from chat (ADR 0005)", () => {
  it("offers Open app under the agenda, /daily, and /tasks", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    world.clock.current = Date.UTC(2026, 8, 26, 0); // 8am Saturday in Singapore
    await world.tick();
    expect(world.lastText()).toMatch(/^Here's your day\./);
    expect(world.findButton("Open app")).toEqual({ text: "Open app", web_app: { url: APP } });
    await world.send("/daily");
    expect(await world.press("Open app")).toBe(APP);
    await world.send("/tasks");
    expect(await world.press("Open app")).toBe(APP);
  });

  it("adds a persistent Open app keyboard after setup and answers it with an inline launch", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    const summary = world.telegram.calls.find(
      (c) => "text" in c.params && c.params.text?.startsWith("Setup complete."),
    );
    expect(
      summary && "reply_markup" in summary.params ? summary.params.reply_markup : null,
    ).toEqual({
      keyboard: [[{ text: "Open app" }]],
      is_persistent: true,
      resize_keyboard: true,
    });
    await world.send("Open app");
    expect(world.lastText()).toBe("Your tasks and the week:");
    expect(world.findButton("Open app")).toEqual({ text: "Open app", web_app: { url: APP } });
    expect(await count(env.DB, "tasks")).toBe(0); // not captured as a task
    await world.send("/app");
    expect(world.lastText()).toBe("Your tasks and the week:");
  });

  it("offers nothing when the public URL isn't https (local development)", async () => {
    const world = new World(env.DB);
    world.services.config = { ...testConfig, publicBaseUrl: "http://localhost:8787" };
    await setUpOwner(world);
    await world.send("/daily");
    expect(() => world.findButton("Open app")).toThrow();
    await world.send("/app");
    expect(world.lastText()).toBe("The app isn't available here yet.");
  });
});
