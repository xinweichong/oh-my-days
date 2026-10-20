/** User-facing copy. Brief and factual; see docs/identity/oh-my-days.md. */

import { BOT_COMMANDS } from "./commands";

export const TAGLINE = "A little less to keep in your head.";

export function introText(): string {
  return ["Oh My Days", TAGLINE, "", "Send /help to see what I can do now."].join("\n");
}

export function helpText(): string {
  return [
    "Type what you want to add, for example:",
    "Dinner Fri 7pm",
    "Buy milk",
    "Pay rent by 1 Nov",
    "",
    "Then reply to the result to change it, for example:",
    "move it to 4pm",
    "remind me 1 day before 6pm",
    "done",
    "",
    "Commands:",
    ...BOT_COMMANDS.map((c) => `/${c.command} – ${c.description}`),
    "",
    "The same list is in the Menu button next to the message box.",
    "I send a daily agenda at 8am and reminders before events and deadlines.",
  ].join("\n");
}

export const NOT_AVAILABLE_YET = "That isn't available yet. Send /help to see what I can do now.";

export const TEXT_ONLY = "I can only read text messages. Send the request as text.";

export const PROCESSING_FAILED = "I couldn't process that message. Please send it again.";

export const BUTTON_EXPIRED = "This button is no longer valid.";

export const PRIVATE_BOT = "This bot is private.";
