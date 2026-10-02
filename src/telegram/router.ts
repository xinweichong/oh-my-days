import type { Guard } from "../storage/guard";
import type { UserRecord } from "../storage/users";
import type { TelegramCall } from "./api";
import { BUTTON_EXPIRED, helpText, introText, NOT_AVAILABLE_YET, TEXT_ONLY } from "./messages";
import type { InboundCallback, InboundMessage, InboundUpdate } from "./update";

export interface HandlerResult {
  replies: TelegramCall[];
  /** Local state changes committed atomically with the replies and inbox completion. */
  statements?: (guard: Guard) => D1PreparedStatement[];
}

/**
 * Handles one accepted update. Handlers must be idempotent: after a crash the
 * same update can be handled again, and only the last attempt's results commit.
 */
export type UpdateHandler = (user: UserRecord, update: InboundUpdate) => Promise<HandlerResult>;

export type CallbackHandler = (
  user: UserRecord,
  callback: InboundCallback,
) => Promise<HandlerResult>;

export interface RouterDeps {
  /** Handles button presses; defaults to treating every button as expired. */
  onCallback?: CallbackHandler;
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
