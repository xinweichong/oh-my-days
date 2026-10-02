/**
 * Normalizes untrusted Telegram webhook JSON into the minimal shape the bot uses.
 * Anything unrecognized is ignored rather than guessed at.
 */

export type ChatType = "private" | "group" | "supergroup" | "channel";

interface Sender {
  updateId: number;
  fromId: number;
  chatId: number;
  chatType: ChatType;
}

export interface InboundMessage extends Sender {
  kind: "message";
  messageId: number;
  /** Null for non-text messages (photos, voice notes, stickers…), which are unsupported. */
  text: string | null;
  replyToMessageId: number | null;
  forwarded: boolean;
}

export interface InboundCallback extends Sender {
  kind: "callback_query";
  callbackQueryId: string;
  data: string | null;
  messageId: number | null;
}

export type InboundUpdate = InboundMessage | InboundCallback;

export type ParsedUpdate =
  | { ok: true; update: InboundUpdate }
  | { ok: false; updateId: number | null; reason: "malformed" | "unsupported" };

/** Telegram limits text messages to 4096 characters; anything larger is not a message we accept. */
const MAX_TEXT_LENGTH = 4096;
/** Telegram limits callback data to 64 bytes. */
const MAX_CALLBACK_DATA_LENGTH = 64;

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeInt(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function chatType(value: unknown): ChatType | null {
  return value === "private" || value === "group" || value === "supergroup" || value === "channel"
    ? value
    : null;
}

export function parseUpdate(body: unknown): ParsedUpdate {
  if (!isObject(body)) return { ok: false, updateId: null, reason: "malformed" };
  const updateId = safeInt(body.update_id);
  if (updateId === null || updateId < 0) return { ok: false, updateId: null, reason: "malformed" };

  if (isObject(body.message)) return parseMessage(updateId, body.message);
  if (isObject(body.callback_query)) return parseCallback(updateId, body.callback_query);
  // edited_message, channel_post, inline queries, etc. are outside scope.
  return { ok: false, updateId, reason: "unsupported" };
}

function parseMessage(updateId: number, message: Json): ParsedUpdate {
  const from = isObject(message.from) ? message.from : null;
  const chat = isObject(message.chat) ? message.chat : null;
  const fromId = safeInt(from?.id);
  const chatId = safeInt(chat?.id);
  const type = chatType(chat?.type);
  const messageId = safeInt(message.message_id);
  if (fromId === null || chatId === null || type === null || messageId === null) {
    return { ok: false, updateId, reason: "malformed" };
  }
  let text: string | null = null;
  if (typeof message.text === "string") {
    if (message.text.length > MAX_TEXT_LENGTH) return { ok: false, updateId, reason: "malformed" };
    text = message.text;
  }
  const replyTo = isObject(message.reply_to_message) ? message.reply_to_message : null;
  return {
    ok: true,
    update: {
      kind: "message",
      updateId,
      fromId,
      chatId,
      chatType: type,
      messageId,
      text,
      replyToMessageId: safeInt(replyTo?.message_id),
      forwarded: message.forward_origin !== undefined,
    },
  };
}

function parseCallback(updateId: number, query: Json): ParsedUpdate {
  const from = isObject(query.from) ? query.from : null;
  const message = isObject(query.message) ? query.message : null;
  const chat = message && isObject(message.chat) ? message.chat : null;
  const fromId = safeInt(from?.id);
  const chatId = safeInt(chat?.id);
  const type = chatType(chat?.type);
  const callbackQueryId = typeof query.id === "string" && query.id.length <= 64 ? query.id : null;
  if (fromId === null || chatId === null || type === null || callbackQueryId === null) {
    return { ok: false, updateId, reason: "malformed" };
  }
  let data: string | null = null;
  if (typeof query.data === "string") {
    if (new TextEncoder().encode(query.data).length > MAX_CALLBACK_DATA_LENGTH) {
      return { ok: false, updateId, reason: "malformed" };
    }
    data = query.data;
  }
  return {
    ok: true,
    update: {
      kind: "callback_query",
      updateId,
      fromId,
      chatId,
      chatType: type,
      callbackQueryId,
      data,
      messageId: safeInt(message?.message_id),
    },
  };
}
