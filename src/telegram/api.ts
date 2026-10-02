/** The subset of Telegram Bot API calls the bot makes. Text is sent without parse_mode. */

export type InlineKeyboardButton =
  | {
      text: string;
      /** At most 64 bytes; always an opaque server-side reference, never data to trust. */
      callback_data: string;
    }
  | { text: string; url: string };

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

export type TelegramCall =
  | {
      method: "sendMessage";
      params: {
        chat_id: number;
        text: string;
        reply_markup?: InlineKeyboardMarkup;
        reply_parameters?: { message_id: number; allow_sending_without_reply: true };
      };
    }
  | {
      method: "editMessageText";
      params: {
        chat_id: number;
        message_id: number;
        text: string;
        reply_markup?: InlineKeyboardMarkup;
      };
    }
  | {
      /** Used to remove buttons once they have been acted on. */
      method: "editMessageReplyMarkup";
      params: { chat_id: number; message_id: number; reply_markup?: InlineKeyboardMarkup };
    }
  | {
      method: "answerCallbackQuery";
      params: { callback_query_id: string; text?: string };
    };

export type TelegramMethod = TelegramCall["method"];

/**
 * Whether repeating a call whose outcome is unknown is harmless. A duplicate
 * sendMessage is visible to the user, so it is never replayed automatically.
 */
export function isReplaySafe(method: TelegramMethod): boolean {
  return method !== "sendMessage";
}
