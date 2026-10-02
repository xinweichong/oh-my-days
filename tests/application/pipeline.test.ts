import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { httpDeps } from "../../src/app";
import {
  DELETE_EVENT,
  type DeleteEventIntent,
  deletePreview,
} from "../../src/application/event-operations";
import { route } from "../../src/http/router";
import { FakeTelegram, OWNER, testServices } from "../support/fakes";
import {
  CAL,
  calendarOf,
  createUser,
  dinner,
  harness,
  messages,
  submit,
} from "../support/operations";
import { callbackUpdate, webhookRequest } from "../support/telegram";

describe("webhook to Calendar pipeline", () => {
  it("confirms, executes, and reports a deletion from one button press, once", async () => {
    const h = harness(env.DB);
    const owner = await createUser(h, OWNER);
    calendarOf(h, owner).seed(CAL, "evt1", dinner());
    const intent: DeleteEventIntent = { calendarId: CAL, eventId: "evt1", base: dinner() };
    await submit(h, owner, {
      kind: DELETE_EVENT,
      idempotencyKey: "d1",
      intent,
      confirmation: deletePreview(intent, owner),
    });
    const confirm = (await messages(env.DB, owner.id))[0]?.buttons[0]?.token ?? "";
    // The prompt was delivered earlier; only new traffic matters below.
    await env.DB.prepare("UPDATE telegram_outbox SET status = 'sent', payload = NULL").run();

    const telegram = new FakeTelegram();
    const services = testServices(env.DB, {
      clock: h.clock,
      ids: h.ids,
      telegram,
      handlers: h.handlers,
      calendarFor: h.calendarFor,
    });
    const update = callbackUpdate(OWNER, `o:${confirm}`);
    for (let delivery = 0; delivery < 2; delivery++) {
      const ctx = createExecutionContext();
      const response = await route(
        webhookRequest(update),
        httpDeps(() => services),
        ctx,
      );
      await waitOnExecutionContext(ctx);
      expect(response.status).toBe(200);
    }

    expect(calendarOf(h, owner).live(CAL, "evt1")).toBeNull();
    expect(telegram.calls.map((c) => c.method)).toEqual([
      "answerCallbackQuery",
      "editMessageReplyMarkup",
      "sendMessage",
    ]);
    expect(telegram.texts()).toEqual([
      "Confirmed.",
      "Event deleted: Dinner\nFri 25 Sep 2026, 7–8pm",
    ]);
  });
});
