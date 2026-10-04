/** Synthetic Telegram update payloads. No real user data. */

let nextUpdateId = 10_000;
let nextMessageId = 1;

export function freshUpdateId(): number {
  return nextUpdateId++;
}

export function textUpdate(
  fromId: number,
  text: string,
  options: { updateId?: number; chatType?: string; chatId?: number; replyTo?: number } = {},
): Record<string, unknown> {
  const chatId = options.chatId ?? fromId;
  return {
    update_id: options.updateId ?? freshUpdateId(),
    message: {
      message_id: nextMessageId++,
      date: 1_790_000_000,
      from: { id: fromId, is_bot: false, first_name: "Test" },
      chat: { id: chatId, type: options.chatType ?? "private" },
      text,
      ...(options.replyTo !== undefined
        ? { reply_to_message: { message_id: options.replyTo } }
        : {}),
    },
  };
}

export function callbackUpdate(
  fromId: number,
  data: string,
  options: { updateId?: number } = {},
): Record<string, unknown> {
  return {
    update_id: options.updateId ?? freshUpdateId(),
    callback_query: {
      id: `cb-${nextMessageId}`,
      from: { id: fromId, is_bot: false, first_name: "Test" },
      message: { message_id: nextMessageId++, chat: { id: fromId, type: "private" } },
      data,
    },
  };
}

export function webhookRequest(
  body: unknown,
  secret = "test-webhook-secret",
  init: { rawBody?: string } = {},
): Request {
  return new Request("https://example.test/telegram/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret },
    body: init.rawBody ?? JSON.stringify(body),
  });
}

/** Records an update exactly as the webhook would, without processing it. */
export async function acceptUpdate(
  db: D1Database,
  raw: Record<string, unknown>,
  now: number,
  ids: { next(): string },
): Promise<void> {
  const { parseUpdate } = await import("../../src/telegram/update");
  const { upsertUserStatement } = await import("../../src/storage/users");
  const { insertInboxStatement } = await import("../../src/storage/inbox");
  const parsed = parseUpdate(raw);
  if (!parsed.ok) throw new Error("fixture update did not parse");
  const u = parsed.update;
  await db.batch([
    upsertUserStatement(db, ids, u.fromId, u.chatId, now),
    insertInboxStatement(db, u, now),
  ]);
}

export async function userIdFor(db: D1Database, telegramUserId: number): Promise<string> {
  const row = await db
    .prepare("SELECT id FROM users WHERE telegram_user_id = ?")
    .bind(telegramUserId)
    .first<{ id: string }>();
  if (!row) throw new Error("user not found");
  return row.id;
}
