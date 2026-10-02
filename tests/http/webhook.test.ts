import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { httpDeps, type Services } from "../../src/app";
import { route } from "../../src/http/router";
import { MAX_WEBHOOK_BODY_BYTES } from "../../src/http/telegram-webhook";
import { count, rows } from "../support/db";
import { FakeTelegram, OTHER_USER, OWNER, STRANGER, testServices } from "../support/fakes";
import { callbackUpdate, textUpdate, webhookRequest } from "../support/telegram";

async function post(request: Request, services: Services): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await route(
    request,
    httpDeps(() => services),
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

describe("Telegram webhook", () => {
  it("rejects requests without the webhook secret and stores nothing", async () => {
    const services = testServices(env.DB);
    const response = await post(webhookRequest(textUpdate(OWNER, "/start"), "wrong"), services);
    expect(response.status).toBe(401);
    expect(await count(env.DB, "telegram_inbox")).toBe(0);
    expect(await count(env.DB, "users")).toBe(0);
  });

  it("persists an allowlisted private message, then replies", async () => {
    const telegram = new FakeTelegram();
    const services = testServices(env.DB, { telegram });
    const response = await post(webhookRequest(textUpdate(OWNER, "/start")), services);

    expect(response.status).toBe(200);
    const [user] = await rows<{ telegram_user_id: number; timezone: string }>(
      env.DB,
      "SELECT telegram_user_id, timezone FROM users",
    );
    expect(user).toEqual({ telegram_user_id: OWNER, timezone: "Asia/Singapore" });
    const [inbox] = await rows<{ status: string; payload: string | null }>(
      env.DB,
      "SELECT status, payload FROM telegram_inbox",
    );
    expect(inbox).toEqual({ status: "processed", payload: null });
    expect(telegram.texts()).toHaveLength(1);
    expect(telegram.texts()[0]).toContain("A little less to keep in your head.");
  });

  it("handles a redelivered update only once", async () => {
    const telegram = new FakeTelegram();
    const services = testServices(env.DB, { telegram });
    const update = textUpdate(OWNER, "/help");

    expect((await post(webhookRequest(update), services)).status).toBe(200);
    expect((await post(webhookRequest(update), services)).status).toBe(200);

    expect(await count(env.DB, "telegram_inbox")).toBe(1);
    expect(await count(env.DB, "telegram_outbox")).toBe(1);
    expect(telegram.calls).toHaveLength(1);
  });

  it("tells users outside the allowlist the bot is private, without storing anything", async () => {
    const telegram = new FakeTelegram();
    const services = testServices(env.DB, { telegram });
    const response = await post(webhookRequest(textUpdate(STRANGER, "hello")), services);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      method: "sendMessage",
      chat_id: STRANGER,
      text: "This bot is private.",
    });
    expect(await count(env.DB, "users")).toBe(0);
    expect(await count(env.DB, "telegram_inbox")).toBe(0);
    expect(telegram.calls).toHaveLength(0);
  });

  it("drops allowlisted users' messages from group chats", async () => {
    const services = testServices(env.DB);
    const update = textUpdate(OWNER, "/start", { chatType: "group", chatId: -500 });
    const response = await post(webhookRequest(update), services);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(""); // no reply into groups
    expect(await count(env.DB, "telegram_inbox")).toBe(0);
  });

  it("ignores callbacks from a different user than the chat owner", async () => {
    const services = testServices(env.DB);
    const update = callbackUpdate(OWNER, "x") as {
      callback_query: { message: { chat: { id: number } } };
    };
    update.callback_query.message.chat.id = OTHER_USER;
    expect((await post(webhookRequest(update), services)).status).toBe(200);
    expect(await count(env.DB, "telegram_inbox")).toBe(0);
  });

  it("rejects oversized bodies before parsing", async () => {
    const services = testServices(env.DB);
    const rawBody = "x".repeat(MAX_WEBHOOK_BODY_BYTES + 1);
    const response = await post(webhookRequest(null, undefined, { rawBody }), services);
    expect(response.status).toBe(413);
  });

  it("acknowledges malformed JSON so Telegram does not redeliver it forever", async () => {
    const services = testServices(env.DB);
    const response = await post(webhookRequest(null, undefined, { rawBody: "{" }), services);
    expect(response.status).toBe(200);
    expect(await count(env.DB, "telegram_inbox")).toBe(0);
  });

  it("asks Telegram to redeliver when the update cannot be persisted", async () => {
    const failingDb = {
      prepare: env.DB.prepare.bind(env.DB),
      batch: async () => {
        throw new Error("D1 unavailable");
      },
    } as unknown as D1Database;
    const services = testServices(failingDb);
    const response = await post(webhookRequest(textUpdate(OWNER, "/start")), services);
    expect(response.status).toBe(503);
  });

  it("does not accept updates for a disabled user", async () => {
    const services = testServices(env.DB);
    await post(webhookRequest(textUpdate(OWNER, "/start")), services);
    await env.DB.prepare("UPDATE users SET status = 'disabled'").run();

    await post(webhookRequest(textUpdate(OWNER, "/help")), services);
    expect(await count(env.DB, "telegram_inbox")).toBe(1);
  });
});

describe("Worker entry point", () => {
  it("serves a minimal liveness check", async () => {
    const response = await exports.default.fetch("https://example.test/healthz");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });

  it("returns 404 for unknown paths and 405 for wrong methods", async () => {
    expect((await exports.default.fetch("https://example.test/nope")).status).toBe(404);
    expect((await exports.default.fetch("https://example.test/telegram/webhook")).status).toBe(405);
  });
});
