import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { syncBotCommands } from "../../src/jobs/bot-commands";
import { BOT_COMMANDS } from "../../src/telegram/commands";
import { helpText, NOT_AVAILABLE_YET } from "../../src/telegram/messages";
import { FakeClock, FakeTelegram } from "../support/fakes";
import { World } from "../support/world";

describe("command menu", () => {
  it("lists only valid, unique commands within Telegram's limits", () => {
    const names = BOT_COMMANDS.map((c) => c.command);
    expect(new Set(names).size).toBe(names.length);
    for (const { command, description } of BOT_COMMANDS) {
      expect(command).toMatch(/^[a-z0-9_]{1,32}$/);
      expect(description.length).toBeGreaterThan(0);
      expect(description.length).toBeLessThanOrEqual(256);
    }
  });

  it("offers only commands the bot actually handles, and /help lists them all", async () => {
    const world = new World(env.DB);
    for (const { command } of BOT_COMMANDS) {
      const before = world.telegram.calls.length;
      await world.send(`/${command}`);
      const replies = world.texts().slice(-(world.telegram.calls.length - before));
      expect(replies.length, `/${command} got no reply`).toBeGreaterThan(0);
      expect(replies).not.toContain(NOT_AVAILABLE_YET);
    }
    for (const { command } of BOT_COMMANDS) expect(helpText()).toContain(`/${command} –`);
  });

  it("registers the menu once, for private chats, with a commands menu button", async () => {
    const telegram = new FakeTelegram();
    const deps = { db: env.DB, clock: new FakeClock(), telegram };

    expect(await syncBotCommands(deps)).toBe(true);
    expect(await syncBotCommands(deps)).toBe(false);

    expect(telegram.adminCalls).toEqual([
      {
        method: "setMyCommands",
        params: {
          commands: BOT_COMMANDS.map(({ command, description }) => ({ command, description })),
          scope: { type: "all_private_chats" },
        },
      },
      { method: "setChatMenuButton", params: { menu_button: { type: "commands" } } },
    ]);
  });

  it("retries on the next tick if Telegram rejects the registration", async () => {
    const telegram = new FakeTelegram().willReturn({
      kind: "retryable",
      retryAfterMs: null,
      errorClass: "http_502",
    });
    const deps = { db: env.DB, clock: new FakeClock(), telegram };

    expect(await syncBotCommands(deps)).toBe(false);
    expect(await syncBotCommands(deps)).toBe(true);
  });

  it("re-registers when the deployed list differs from the registered one", async () => {
    const telegram = new FakeTelegram();
    const deps = { db: env.DB, clock: new FakeClock(), telegram };
    await syncBotCommands(deps);
    await env.DB.prepare("UPDATE app_state SET value = '[]'").run(); // an older deployment's list

    expect(await syncBotCommands(deps)).toBe(true);
    expect(telegram.adminCalls.filter((c) => c.method === "setMyCommands")).toHaveLength(2);
  });
});
