import type { AppConfig } from "../env";
import { secretsEqual } from "../security/compare";
import type { Clock } from "../shared/clock";
import type { IdGenerator } from "../shared/ids";
import { logEvent } from "../shared/log";
import { insertInboxStatement } from "../storage/inbox";
import { upsertUserStatement } from "../storage/users";
import { PRIVATE_BOT } from "../telegram/messages";
import { parseUpdate } from "../telegram/update";

/** Telegram updates are small; anything larger is rejected before parsing. */
export const MAX_WEBHOOK_BODY_BYTES = 64 * 1024;

export interface WebhookDeps {
  config: AppConfig;
  db: D1Database;
  clock: Clock;
  ids: IdGenerator;
  /** Starts bounded processing after acknowledgement; the scheduler recovers anything missed. */
  afterAccept: (telegramUserId: number) => Promise<void>;
}

/**
 * Authenticates, filters, and durably records an update before acknowledging it.
 * A non-2xx response makes Telegram redeliver, so it is used only when the
 * update could not be persisted.
 */
export async function handleTelegramWebhook(
  request: Request,
  deps: WebhookDeps,
  ctx: ExecutionContext,
): Promise<Response> {
  const secret = request.headers.get("x-telegram-bot-api-secret-token") ?? "";
  if (!(await secretsEqual(secret, deps.config.telegramWebhookSecret))) {
    return new Response(null, { status: 401 });
  }

  const body = await readBoundedText(request, MAX_WEBHOOK_BODY_BYTES);
  if (body === null) return new Response(null, { status: 413 });

  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    logEvent("webhook.ignored", { reason: "invalid_json" });
    return ok();
  }

  const parsed = parseUpdate(json);
  if (!parsed.ok) {
    logEvent("webhook.ignored", { reason: parsed.reason, updateId: parsed.updateId });
    return ok();
  }
  const update = parsed.update;

  // Only allowlisted users in their own private chat. Content from anyone else
  // is dropped without being stored.
  if (
    update.chatType !== "private" ||
    update.chatId !== update.fromId ||
    !deps.config.allowedTelegramUserIds.has(update.fromId)
  ) {
    logEvent("webhook.rejected", { updateId: update.updateId, chatType: update.chatType });
    // A stranger messaging the bot directly gets a short notice, sent as the
    // webhook response: no outbound request, nothing stored, no detail revealed.
    if (update.kind === "message" && update.chatType === "private") {
      return Response.json({ method: "sendMessage", chat_id: update.chatId, text: PRIVATE_BOT });
    }
    return ok();
  }

  const now = deps.clock.now();
  try {
    await deps.db.batch([
      upsertUserStatement(deps.db, deps.ids, update.fromId, update.chatId, now),
      insertInboxStatement(deps.db, update, now),
    ]);
  } catch (error) {
    logEvent("webhook.persist_failed", {
      updateId: update.updateId,
      errorClass: error instanceof Error ? error.name : "unknown",
    });
    return new Response(null, { status: 503 });
  }

  ctx.waitUntil(
    deps.afterAccept(update.fromId).catch((error: unknown) => {
      logEvent("webhook.after_accept_failed", {
        errorClass: error instanceof Error ? error.name : "unknown",
      });
    }),
  );
  return ok();
}

function ok(): Response {
  return new Response(null, { status: 200 });
}

async function readBoundedText(request: Request, maxBytes: number): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > maxBytes) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
