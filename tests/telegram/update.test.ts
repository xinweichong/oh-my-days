import { describe, expect, it } from "vitest";
import { commandName } from "../../src/telegram/router";
import { parseUpdate } from "../../src/telegram/update";
import { callbackUpdate, textUpdate } from "../support/telegram";

describe("parseUpdate", () => {
  it("normalizes a private text message", () => {
    const parsed = parseUpdate(textUpdate(1001, "Buy milk", { updateId: 7 }));
    expect(parsed).toMatchObject({
      ok: true,
      update: {
        kind: "message",
        updateId: 7,
        fromId: 1001,
        chatId: 1001,
        chatType: "private",
        text: "Buy milk",
        forwarded: false,
      },
    });
  });

  it("marks forwarded text and keeps non-text messages with null text", () => {
    const forwarded = textUpdate(1001, "Lunch Friday") as { message: Record<string, unknown> };
    forwarded.message.forward_origin = { type: "hidden_user", date: 0, sender_user_name: "X" };
    expect(parseUpdate(forwarded)).toMatchObject({ ok: true, update: { forwarded: true } });

    const photo = textUpdate(1001, "") as { message: Record<string, unknown> };
    delete photo.message.text;
    photo.message.photo = [];
    expect(parseUpdate(photo)).toMatchObject({ ok: true, update: { text: null } });
  });

  it("normalizes callback queries", () => {
    expect(parseUpdate(callbackUpdate(1001, "c:abc"))).toMatchObject({
      ok: true,
      update: { kind: "callback_query", fromId: 1001, chatId: 1001, data: "c:abc" },
    });
  });

  it("ignores unsupported update types and rejects malformed ones", () => {
    expect(parseUpdate({ update_id: 1, edited_message: {} })).toEqual({
      ok: false,
      updateId: 1,
      reason: "unsupported",
    });
    expect(parseUpdate({ update_id: "1" })).toMatchObject({ ok: false, reason: "malformed" });
    expect(parseUpdate({ update_id: 1, message: { chat: {} } })).toMatchObject({
      ok: false,
      reason: "malformed",
    });
    expect(parseUpdate([])).toMatchObject({ ok: false, reason: "malformed" });
  });

  it("rejects callback data beyond Telegram's 64-byte limit", () => {
    expect(parseUpdate(callbackUpdate(1001, "x".repeat(65)))).toMatchObject({
      ok: false,
      reason: "malformed",
    });
  });
});

describe("commandName", () => {
  it("recognizes commands, including the @bot suffix", () => {
    expect(commandName("/start")).toBe("start");
    expect(commandName("/HELP@OhMyDaysBot now")).toBe("help");
    expect(commandName("start")).toBeNull();
    expect(commandName("/")).toBeNull();
  });
});
