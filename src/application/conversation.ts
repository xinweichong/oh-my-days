import { findPendingInput, findUiAction } from "../storage/interactions";
import type { UserRecord } from "../storage/users";
import { BUTTON_EXPIRED, TAGLINE } from "../telegram/messages";
import { createUpdateHandler, type UpdateHandler } from "../telegram/router";
import type { InboundCallback } from "../telegram/update";
import { createCallbackHandler } from "./callbacks";
import {
  eventMenu,
  handleEventAction,
  handleEventInput,
  isEventAction,
  isEventInput,
} from "./event-flow";
import type { HandlerRegistry } from "./operation-types";
import { message, type Reaction, UI_PREFIX } from "./reactions";
import {
  handlePendingInput,
  handleUiAction,
  healthView,
  type SetupDeps,
  settingsView,
  setupPrompt,
} from "./setup";

export interface ConversationDeps extends SetupDeps {
  handlers: HandlerRegistry;
}

/** The Telegram conversation: commands, setup, settings, health, and buttons. */
export function createConversation(deps: ConversationDeps): UpdateHandler {
  const operationCallbacks = createCallbackHandler(deps);

  const onCallback = async (user: UserRecord, callback: InboundCallback): Promise<Reaction> => {
    if (callback.data?.startsWith(UI_PREFIX)) {
      const token = callback.data.slice(UI_PREFIX.length);
      const action = await findUiAction(deps.db, user.id, token, deps.clock.now());
      if (!action) {
        return {
          replies: [
            {
              method: "answerCallbackQuery",
              params: { callback_query_id: callback.callbackQueryId, text: BUTTON_EXPIRED },
            },
          ],
        };
      }
      if (isEventAction(action.action)) return handleEventAction(deps, user, callback, action);
      return handleUiAction(deps, user, callback, action);
    }
    return operationCallbacks(user, callback);
  };

  return createUpdateHandler({
    onCallback,
    commands: {
      start: async (user) => {
        if (user.setupStep !== "done") return setupPrompt(deps, user);
        return message(
          user.privateChatId,
          `Oh My Days\n${TAGLINE}\n\nSetup is complete. Send /help to see what I can do.`,
        );
      },
      settings: (user) => settingsView(deps, user),
      event: (user) => eventMenu(deps, user),
      health: (user) => healthView(deps, user),
    },
    onText: async (user, input) => {
      const pending = await findPendingInput(deps.db, user.id, deps.clock.now());
      if (pending && isEventInput(pending.kind)) {
        return handleEventInput(deps, user, input, pending);
      }
      if (pending) return handlePendingInput(deps, user, input, pending.kind);
      if (user.setupStep !== "done") {
        return message(user.privateChatId, "Finish setup first: send /start to continue.");
      }
      return null;
    },
  });
}
