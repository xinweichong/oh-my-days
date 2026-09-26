/** User-facing copy. Brief and factual; see docs/identity/oh-my-days.md. */

export const TAGLINE = "A little less to keep in your head.";

export function introText(): string {
  return [
    "Oh My Days",
    TAGLINE,
    "",
    "Google Calendar connection isn't available yet. Send /help to see what I can do now.",
  ].join("\n");
}

export function helpText(): string {
  return [
    "Available commands:",
    "/start – Introduction",
    "/help – This list",
    "",
    "Events, tasks, and reminders are still being built.",
  ].join("\n");
}

export const NOT_AVAILABLE_YET = "That isn't available yet. Send /help to see what I can do now.";

export const TEXT_ONLY = "I can only read text messages. Send the request as text.";

export const PROCESSING_FAILED = "I couldn't process that message. Please send it again.";

export const BUTTON_EXPIRED = "This button is no longer valid.";
