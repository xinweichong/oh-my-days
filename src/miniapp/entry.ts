import type { AppConfig } from "../env";
import type { InlineKeyboardButton, ReplyKeyboardMarkup, TelegramCall } from "../telegram/api";

/**
 * Ways into the Mini App from chat (ADR 0005). Telegram only opens https
 * Mini Apps, so nothing is offered when the public URL isn't https (local
 * development).
 */

/** The persistent keyboard button's text; the bot answers it with an inline launch. */
export const OPEN_APP_TEXT = "Open app";

export function appUrl(config: Pick<AppConfig, "publicBaseUrl">): string | null {
  return config.publicBaseUrl.startsWith("https://") ? `${config.publicBaseUrl}/app` : null;
}

/** An inline button that opens the Mini App with signed initData. */
export function appButton(url: string | null): InlineKeyboardButton | null {
  return url ? { text: OPEN_APP_TEXT, web_app: { url } } : null;
}

/** The keyboard under the message box. Keyboard launches carry no initData, so it's plain text. */
export const APP_KEYBOARD: ReplyKeyboardMarkup = {
  keyboard: [[{ text: OPEN_APP_TEXT }]],
  is_persistent: true,
  resize_keyboard: true,
};

/** The answer to "Open app" or /app: one inline button that opens it. */
export function openAppMessage(chatId: number, url: string | null): TelegramCall {
  const button = appButton(url);
  return {
    method: "sendMessage",
    params: button
      ? {
          chat_id: chatId,
          text: "Your tasks and the week:",
          reply_markup: { inline_keyboard: [[button]] },
        }
      : { chat_id: chatId, text: "The app isn't available here yet." },
  };
}
