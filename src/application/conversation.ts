import { APP_KEYBOARD, appUrl, OPEN_APP_TEXT, openAppMessage } from "../miniapp/entry";
import { findPendingInput, findUiAction } from "../storage/interactions";
import type { UserRecord } from "../storage/users";
import { BUTTON_EXPIRED, TAGLINE } from "../telegram/messages";
import { createUpdateHandler, type UpdateHandler } from "../telegram/router";
import type { InboundCallback } from "../telegram/update";
import type { SourceFor } from "./calendar-view";
import { createCallbackHandler } from "./callbacks";
import { cancelCommand, handleCancelAction, isCancelAction } from "./cancel";
import { handleCapture, handleCaptureAction, isCaptureAction } from "./capture-flow";
import { handleConflictAction, isConflictAction } from "./conflict-flow";
import {
  eventMenu,
  handleEventAction,
  handleEventInput,
  isEventAction,
  isEventInput,
} from "./event-flow";
import { exportCommand } from "./export-flow";
import { findCommand, handleFindAction, handleFindInput, isFindAction } from "./find-flow";
import { handleFollowUp, handleFollowUpAction, isFollowUpAction } from "./follow-ups";
import {
  handleImportAction,
  handleImportInput,
  importCommand,
  isImportAction,
} from "./import-flow";
import {
  handleInviteAction,
  handleInviteInput,
  isInviteAction,
  isInviteInput,
} from "./invite-flow";
import type { HandlerRegistry } from "./operation-types";
import { message, type Reaction, UI_PREFIX } from "./reactions";
import { handleReminderAction, handleReminderInput, isReminderAction } from "./reminder-flow";
import {
  handlePendingInput,
  handleUiAction,
  healthView,
  type SetupDeps,
  settingsView,
  setupPrompt,
} from "./setup";
import {
  handleTaskAction,
  handleTaskInput,
  isTaskAction,
  isTaskInput,
  taskMenu,
  tasksCommand,
} from "./task-flow";
import {
  calendarsView,
  dailyView,
  handleSnoozeInput,
  handleViewAction,
  isViewAction,
  monthView,
  overdueView,
  remindersView,
  weekView,
} from "./view-flow";

export interface ConversationDeps extends SetupDeps {
  handlers: HandlerRegistry;
  sourceFor: SourceFor;
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
      if (isCancelAction(action.action)) return handleCancelAction(deps, user, callback, action);
      if (isInviteAction(action.action)) return handleInviteAction(deps, user, callback, action);
      if (isConflictAction(action.action))
        return handleConflictAction(deps, user, callback, action);
      if (isEventAction(action.action)) return handleEventAction(deps, user, callback, action);
      if (isCaptureAction(action.action)) return handleCaptureAction(deps, user, callback, action);
      if (isFindAction(action.action)) return handleFindAction(deps, user, callback, action);
      if (isImportAction(action.action)) return handleImportAction(deps, user, callback, action);
      if (isFollowUpAction(action.action))
        return handleFollowUpAction(deps, user, callback, action);
      if (isTaskAction(action.action)) return handleTaskAction(deps, user, callback, action);
      if (isReminderAction(action.action))
        return handleReminderAction(deps, user, callback, action);
      if (isViewAction(action.action)) return handleViewAction(deps, user, callback, action);
      return handleUiAction(deps, user, callback, action);
    }
    return operationCallbacks(user, callback);
  };

  return createUpdateHandler({
    onCallback,
    commands: {
      start: async (user) => {
        if (user.setupStep !== "done") return setupPrompt(deps, user);
        const text = `Oh My Days\n${TAGLINE}\n\nSetup is complete. Send /help to see what I can do.`;
        return {
          replies: [
            {
              method: "sendMessage",
              params: {
                chat_id: user.privateChatId,
                text,
                ...(appUrl(deps.config) ? { reply_markup: APP_KEYBOARD } : {}),
              },
            },
          ],
        };
      },
      app: async (user) =>
        user.setupStep === "done"
          ? { replies: [openAppMessage(user.privateChatId, appUrl(deps.config))] }
          : message(user.privateChatId, "Finish setup first: send /start to continue."),
      cancel: (user) => cancelCommand(deps, user),
      settings: (user) => settingsView(deps, user),
      event: (user) => eventMenu(deps, user),
      task: (user) => taskMenu(deps, user),
      tasks: (user) => tasksCommand(deps, user),
      find: (user, input) => findCommand(deps, user, input),
      import: (user, input) => importCommand(deps, user, input),
      export: (user) => exportCommand(deps, user),
      daily: (user) => dailyView(deps, user),
      weekly: (user) => weekView(deps, user, null, null, null),
      monthly: (user) => monthView(deps, user, null, null),
      calendars: (user) => calendarsView(deps, user),
      overdue: (user) => overdueView(deps, user),
      reminders: (user) => remindersView(deps, user),
      health: (user) => healthView(deps, user),
    },
    onText: async (user, input) => {
      // The persistent keyboard button (keyboard launches can't sign in; ADR 0005).
      if (input.text?.trim() === OPEN_APP_TEXT && user.setupStep === "done") {
        return { replies: [openAppMessage(user.privateChatId, appUrl(deps.config))] };
      }
      const pending = await findPendingInput(deps.db, user.id, deps.clock.now());
      if (pending && isInviteInput(pending.kind)) {
        return handleInviteInput(deps, user, input, pending);
      }
      if (pending && isEventInput(pending.kind)) {
        return handleEventInput(deps, user, input, pending);
      }
      if (pending?.kind === "task_snooze") return handleSnoozeInput(deps, user, input, pending);
      if (pending?.kind === "reminder_input")
        return handleReminderInput(deps, user, input, pending);
      if (pending?.kind === "find_query") return handleFindInput(deps, user, input, pending);
      if (pending?.kind === "import_list") return handleImportInput(deps, user, input, pending);
      if (pending && isTaskInput(pending.kind)) {
        return handleTaskInput(deps, user, input, pending);
      }
      if (pending) return handlePendingInput(deps, user, input, pending.kind);
      if (user.setupStep !== "done") {
        return message(user.privateChatId, "Finish setup first: send /start to continue.");
      }
      // "Move it to 4pm" and similar follow-ups about one item.
      const followUp = await handleFollowUp(deps, user, input);
      if (followUp) return followUp;
      // Anything else is a new event or task (quick capture), or a question.
      return handleCapture(deps, user, input);
    },
  });
}
