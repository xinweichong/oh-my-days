import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { CALLBACK_TEXT, createCallbackHandler } from "../../src/application/callbacks";
import {
  CREATE_EVENT,
  type CreateEventIntent,
  DELETE_EVENT,
  type DeleteEventIntent,
  deletePreview,
  PATCH_EVENT,
  type PatchEventIntent,
} from "../../src/application/event-operations";
import { runDueOperations } from "../../src/application/operation-runner";
import { CONFIRMATION_TTL_MS } from "../../src/application/proposals";
import { runTick } from "../../src/jobs/tick";
import type { UserRecord } from "../../src/storage/users";
import { BUTTON_EXPIRED } from "../../src/telegram/messages";
import type { HandlerResult } from "../../src/telegram/router";
import type { InboundCallback } from "../../src/telegram/update";
import { FakeTelegram, OTHER_USER, OWNER } from "../support/fakes";
import {
  at,
  CAL,
  calendarOf,
  createUser,
  dinner,
  type Harness,
  harness,
  messages,
  operationRow,
  submit,
} from "../support/operations";

let pressCount = 0;

/** Presses a button as `user`. Each press is a distinct Telegram callback query. */
async function press(
  h: Harness,
  user: UserRecord,
  token: string,
  callbackQueryId = `press-${++pressCount}`,
): Promise<HandlerResult> {
  const handler = createCallbackHandler(h);
  const callback: InboundCallback = {
    kind: "callback_query",
    updateId: pressCount,
    fromId: user.telegramUserId,
    chatId: user.privateChatId,
    chatType: "private",
    callbackQueryId,
    data: `o:${token}`,
    messageId: 77,
  };
  return handler(user, callback);
}

/** The confirmation prompt a press produced, with its button tokens. */
function promptOf(result: HandlerResult): {
  text: string;
  buttons: { text: string; token: string }[];
} {
  const call = result.replies.find((r) => r.method === "sendMessage");
  if (call?.method !== "sendMessage") throw new Error("no prompt");
  return {
    text: call.params.text,
    buttons: (call.params.reply_markup?.inline_keyboard ?? []).flat().map((b) => ({
      text: b.text,
      token: "callback_data" in b ? b.callback_data.replace(/^o:/, "") : "",
    })),
  };
}

function answerText(result: HandlerResult): string | undefined {
  const call = result.replies.find((r) => r.method === "answerCallbackQuery");
  return call?.method === "answerCallbackQuery" ? call.params.text : undefined;
}

async function proposeDelete(h: Harness, user: UserRecord) {
  calendarOf(h, user).seed(CAL, "evt1", dinner());
  const intent: DeleteEventIntent = { calendarId: CAL, eventId: "evt1", base: dinner() };
  const prepared = await submit(h, user, {
    kind: DELETE_EVENT,
    idempotencyKey: "delete-1",
    intent,
    confirmation: deletePreview(intent, user),
  });
  const [prompt] = await messages(env.DB, user.id);
  const [confirm, cancel] = prompt?.buttons ?? [];
  if (!confirm || !cancel) throw new Error("confirmation buttons missing");
  return {
    operationId: prepared.operationId,
    prompt,
    confirm: confirm.token,
    cancel: cancel.token,
  };
}

async function createAndRun(h: Harness, user: UserRecord): Promise<string> {
  const intent: CreateEventIntent = { calendarId: CAL, eventId: "evt1", fields: dinner() };
  await submit(h, user, { kind: CREATE_EVENT, idempotencyKey: "c1", intent, confirmation: null });
  await runDueOperations(h, 10);
  const undo = (await messages(env.DB, user.id)).at(-1)?.buttons[0];
  if (undo?.text !== "Undo") throw new Error("undo button missing");
  return undo.token;
}

describe("confirmation", () => {
  it("previews a deletion and changes nothing until confirmed", async () => {
    const h = harness(env.DB);
    const owner = await createUser(h, OWNER);
    const { operationId, prompt } = await proposeDelete(h, owner);

    expect(prompt?.text).toBe(
      "Delete event: Dinner\nFri 25 Sep 2026, 7–8pm\n\nThis removes it from Google Calendar.",
    );
    expect(prompt?.buttons.map((b) => b.text)).toEqual(["Delete", "Cancel"]);
    expect(await runDueOperations(h, 10)).toBe(0);
    expect(calendarOf(h, owner).live(CAL, "evt1")).not.toBeNull();
    expect((await operationRow(env.DB, operationId)).status).toBe("awaiting_confirmation");
  });

  it("executes exactly once after confirmation, even if pressed again", async () => {
    const h = harness(env.DB);
    const owner = await createUser(h, OWNER);
    const { operationId, confirm } = await proposeDelete(h, owner);

    const first = await press(h, owner, confirm);
    expect(answerText(first)).toBe(CALLBACK_TEXT.confirmed);
    expect(first.replies.some((r) => r.method === "editMessageReplyMarkup")).toBe(true);
    expect(answerText(await press(h, owner, confirm))).toBe(BUTTON_EXPIRED);

    await runDueOperations(h, 10);
    await runDueOperations(h, 10);
    expect(calendarOf(h, owner).live(CAL, "evt1")).toBeNull();
    expect(calendarOf(h, owner).calls.filter((c) => c === "delete")).toHaveLength(1);
    expect((await operationRow(env.DB, operationId)).status).toBe("succeeded");
    expect((await messages(env.DB, owner.id)).at(-1)?.text).toBe(
      "Event deleted: Dinner\nFri 25 Sep 2026, 7–8pm",
    );
  });

  it("treats a redelivered press as the same press", async () => {
    const h = harness(env.DB);
    const owner = await createUser(h, OWNER);
    const { confirm } = await proposeDelete(h, owner);

    await press(h, owner, confirm, "same-query");
    expect(answerText(await press(h, owner, confirm, "same-query"))).toBe(CALLBACK_TEXT.confirmed);
  });

  it("ignores another user's button", async () => {
    const h = harness(env.DB);
    const owner = await createUser(h, OWNER);
    const other = await createUser(h, OTHER_USER);
    const { operationId, confirm } = await proposeDelete(h, owner);

    expect(answerText(await press(h, other, confirm))).toBe(BUTTON_EXPIRED);
    expect((await operationRow(env.DB, operationId)).status).toBe("awaiting_confirmation");
    // The owner can still use it.
    expect(answerText(await press(h, owner, confirm))).toBe(CALLBACK_TEXT.confirmed);
  });

  it("rejects malformed button data", async () => {
    const h = harness(env.DB);
    const owner = await createUser(h, OWNER);
    expect(answerText(await press(h, owner, "not a token!"))).toBe(BUTTON_EXPIRED);
  });

  it("expires unanswered confirmations", async () => {
    const h = harness(env.DB);
    const owner = await createUser(h, OWNER);
    const { operationId, confirm } = await proposeDelete(h, owner);
    h.clock.advance(CONFIRMATION_TTL_MS);

    expect(answerText(await press(h, owner, confirm))).toBe(BUTTON_EXPIRED);
    await runTick({
      db: h.db,
      clock: h.clock,
      runner: h,
      inbox: { db: h.db, clock: h.clock, ids: h.ids, handler: async () => ({ replies: [] }) },
      delivery: {
        db: h.db,
        clock: h.clock,
        ids: h.ids,
        telegram: new FakeTelegram(),
        random: h.random,
      },
    });
    expect(await operationRow(env.DB, operationId)).toMatchObject({
      status: "cancelled",
      error_class: "confirmation_expired",
    });
    expect(calendarOf(h, owner).live(CAL, "evt1")).not.toBeNull();
  });

  it("asks again when the event changed after the preview was confirmed", async () => {
    const h = harness(env.DB);
    const owner = await createUser(h, OWNER);
    const { operationId, confirm } = await proposeDelete(h, owner);
    await press(h, owner, confirm);
    calendarOf(h, owner).externalEdit(CAL, "evt1", { start: at(21), end: at(22) });

    await runDueOperations(h, 10);

    expect(calendarOf(h, owner).live(CAL, "evt1")).not.toBeNull();
    expect((await operationRow(env.DB, operationId)).status).toBe("awaiting_confirmation");
    const reprompt = (await messages(env.DB, owner.id)).at(-1);
    expect(reprompt?.text).toContain("Dinner changed since you asked to delete it.");
    expect(reprompt?.text).toContain("Fri 25 Sep 2026, 9–10pm");

    // The new preview needs its own confirmation.
    const newConfirm = reprompt?.buttons[0]?.token ?? "";
    expect(newConfirm).not.toBe(confirm);
    expect(answerText(await press(h, owner, newConfirm))).toBe(CALLBACK_TEXT.confirmed);
    await runDueOperations(h, 10);
    expect(calendarOf(h, owner).live(CAL, "evt1")).toBeNull();
  });

  it("cancels without changing anything, and retires the confirm button", async () => {
    const h = harness(env.DB);
    const owner = await createUser(h, OWNER);
    const { operationId, confirm, cancel } = await proposeDelete(h, owner);

    const result = await press(h, owner, cancel);
    expect(answerText(result)).toBe(CALLBACK_TEXT.cancelled);
    expect(answerText(await press(h, owner, confirm))).toBe(BUTTON_EXPIRED);
    expect((await operationRow(env.DB, operationId)).status).toBe("cancelled");
    expect(await runDueOperations(h, 10)).toBe(0);
    expect(calendarOf(h, owner).live(CAL, "evt1")).not.toBeNull();
  });
});

describe("Undo", () => {
  it("asks before deleting a just-created event, then removes it once", async () => {
    const h = harness(env.DB);
    const owner = await createUser(h, OWNER);
    const undo = await createAndRun(h, owner);

    const pressed = await press(h, owner, undo);
    expect(answerText(pressed)).toBe(CALLBACK_TEXT.undoNeedsConfirmation);
    expect(answerText(await press(h, owner, undo))).toBe(BUTTON_EXPIRED);
    const prompt = promptOf(pressed);
    expect(prompt.text).toBe(
      "Delete event: Dinner\nFri 25 Sep 2026, 7–8pm\n\nThis removes it from Google Calendar.",
    );
    expect(prompt.buttons.map((b) => b.text)).toEqual(["Delete", "Cancel"]);

    // Nothing is deleted until the deletion itself is confirmed.
    expect(await runDueOperations(h, 10)).toBe(0);
    expect(calendarOf(h, owner).live(CAL, "evt1")).not.toBeNull();

    expect(answerText(await press(h, owner, prompt.buttons[0]?.token ?? ""))).toBe(
      CALLBACK_TEXT.confirmed,
    );
    await runDueOperations(h, 10);
    expect(calendarOf(h, owner).live(CAL, "evt1")).toBeNull();
    expect((await messages(env.DB, owner.id)).at(-1)?.text).toBe(
      "Undone: Dinner was removed from Google Calendar.",
    );
  });

  it("keeps the event when the Undo deletion is cancelled", async () => {
    const h = harness(env.DB);
    const owner = await createUser(h, OWNER);
    const undo = await createAndRun(h, owner);
    const prompt = promptOf(await press(h, owner, undo));

    expect(answerText(await press(h, owner, prompt.buttons[1]?.token ?? ""))).toBe(
      CALLBACK_TEXT.cancelled,
    );
    await runDueOperations(h, 10);
    expect(calendarOf(h, owner).live(CAL, "evt1")).not.toBeNull();
  });

  it("does not overwrite an edit made after the original change", async () => {
    const h = harness(env.DB);
    const owner = await createUser(h, OWNER);
    const undo = await createAndRun(h, owner);
    const prompt = promptOf(await press(h, owner, undo));
    calendarOf(h, owner).externalEdit(CAL, "evt1", { summary: "Dinner at 8" });

    await press(h, owner, prompt.buttons[0]?.token ?? "");
    await runDueOperations(h, 10);

    expect(calendarOf(h, owner).live(CAL, "evt1")?.fields.summary).toBe("Dinner at 8");
    expect((await messages(env.DB, owner.id)).at(-1)?.text).toBe(
      "Undo isn't available: Dinner changed in Calendar since it was added.",
    );
  });

  it("restores an edit's previous values and offers no Undo of the Undo", async () => {
    const h = harness(env.DB);
    const owner = await createUser(h, OWNER);
    calendarOf(h, owner).seed(CAL, "evt1", dinner());
    const intent: PatchEventIntent = {
      calendarId: CAL,
      eventId: "evt1",
      title: "Dinner",
      base: { start: dinner().start, end: dinner().end },
      patch: { start: at(16), end: at(17) },
    };
    await submit(h, owner, { kind: PATCH_EVENT, idempotencyKey: "p1", intent, confirmation: null });
    await runDueOperations(h, 10);
    const undo = (await messages(env.DB, owner.id)).at(-1)?.buttons[0]?.token ?? "";

    await press(h, owner, undo);
    await runDueOperations(h, 10);

    expect(calendarOf(h, owner).live(CAL, "evt1")?.fields.start).toEqual(dinner().start);
    const last = (await messages(env.DB, owner.id)).at(-1);
    expect(last?.text).toBe("Undone: Dinner\nFri 25 Sep 2026, 7–8pm");
    expect(last?.buttons).toEqual([]);
  });
});
