import type { UserRecord } from "../storage/users";
import type { InlineKeyboardMarkup, TelegramCall } from "../telegram/api";
import type { InboundCallback } from "../telegram/update";
import type { Reaction } from "./reactions";

/** A message with buttons, sent new or edited in place. */
export function keyboardMessage(
  user: UserRecord,
  text: string,
  keyboard: InlineKeyboardMarkup,
  editMessageId: number | null,
): TelegramCall {
  if (editMessageId !== null) {
    return {
      method: "editMessageText",
      params: {
        chat_id: user.privateChatId,
        message_id: editMessageId,
        text,
        reply_markup: keyboard,
      },
    };
  }
  return {
    method: "sendMessage",
    params: { chat_id: user.privateChatId, text, reply_markup: keyboard },
  };
}

/** Acknowledges a button press, optionally with a short notice. */
export function answer(callback: InboundCallback, text?: string): Reaction {
  return {
    replies: [
      {
        method: "answerCallbackQuery",
        params: { callback_query_id: callback.callbackQueryId, ...(text ? { text } : {}) },
      },
    ],
  };
}

/** Removes the buttons from the message that was pressed. */
export function removeButtons(user: UserRecord, callback: InboundCallback): Reaction {
  if (callback.messageId === null) return { replies: [] };
  return {
    replies: [
      {
        method: "editMessageReplyMarkup",
        params: { chat_id: user.privateChatId, message_id: callback.messageId },
      },
    ],
  };
}
