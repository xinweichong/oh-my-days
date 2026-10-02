import type { Reaction } from "../application/reactions";
import type { UserRecord } from "../storage/users";
import type { TelegramCall } from "./api";
import { BUTTON_EXPIRED, helpText, introText, NOT_AVAILABLE_YET, TEXT_ONLY } from "./messages";
import type { InboundCallback, InboundMessage, InboundUpdate } from "./update";

/** Replies and local state changes committed atomically with the inbox completion. */
export type HandlerResult = Reaction;

/**
 * Handles one accepted update. Handlers must be idempotent: after a crash the
 * same update can be handled again, and only the last attempt's results commit.
 */
export type UpdateHandler = (user: UserRecord, update: InboundUpdate) => Promise<HandlerResult>;

export type CallbackHandler = (
  user: UserRecord,
  callback: InboundCallback,
) => Promise<HandlerResult>;

export type MessageHandler = (user: UserRecord, message: InboundMessage) => Promise<HandlerResult>;

export interface RouterDeps {
  /** Handles button presses; defaults to treating every button as expired. */
  onCallback?: CallbackHandler;
  /** Slash commands by name; these override the built-in /start and /help. */
  commands?: Readonly<Record<string, MessageHandler>>;
  /** Non-command text; null falls through to the default reply. */
  onText?: (user: UserRecord, message: InboundMessage) => Promise<HandlerResult | null>;
}

export function createUpdateHandler(deps: RouterDeps = {}): UpdateHandler {
  return async (user, update) => {
    if (update.kind === "callback_query") {
      if (deps.onCallback) return deps.onCallback(user, update);
      return {
        replies: [
          {
            method: "answerCallbackQuery",
            params: { callback_query_id: update.callbackQueryId, text: BUTTON_EXPIRED },
          },
        ],
      };
    }
    if (update.text !== null) {
      const name = commandName(update.text);
      const command = name ? deps.commands?.[name] : undefined;
      if (command) return command(user, update);
      if (!name && deps.onText) {
        const handled = await deps.onText(user, update);
        if (handled) return handled;
      }
    }
    return { replies: [reply(user, messageResponse(update))] };
  };
}

function messageResponse(message: InboundMessage): string {
  if (message.text === null) return TEXT_ONLY;
  switch (commandName(message.text)) {
    case "start":
      return introText();
    case "help":
      return helpText();
    default:
      return NOT_AVAILABLE_YET;
  }
}

/** Extracts `/name` or `/name@bot` from the start of a message. */
export function commandName(text: string): string | null {
  const match = /^\/([a-z0-9_]{1,32})(?:@[A-Za-z0-9_]+)?(?:\s|$)/i.exec(text.trim());
  return match?.[1]?.toLowerCase() ?? null;
}

function reply(user: UserRecord, text: string): TelegramCall {
  return { method: "sendMessage", params: { chat_id: user.privateChatId, text } };
}
