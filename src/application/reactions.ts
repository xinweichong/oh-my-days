import type { IdGenerator } from "../shared/ids";
import type { Guard } from "../storage/guard";
import { insertUiActionStatement } from "../storage/interactions";
import type { InlineKeyboardButton, TelegramCall } from "../telegram/api";

/**
 * Messages to send plus local state changes, committed together under the
 * caller's guard (an inbox lease, an operation lease, or none).
 */
export interface Reaction {
  replies: TelegramCall[];
  statements?: (db: D1Database, guard: Guard) => D1PreparedStatement[];
}

export function combine(...reactions: Reaction[]): Reaction {
  return {
    replies: reactions.flatMap((r) => r.replies),
    statements: (db, guard) => reactions.flatMap((r) => r.statements?.(db, guard) ?? []),
  };
}

export function message(chatId: number, text: string): Reaction {
  return { replies: [{ method: "sendMessage", params: { chat_id: chatId, text } }] };
}

/** Default lifetime of button tokens; validity is rechecked when pressed. */
export const UI_ACTION_TTL_MS = 30 * 24 * 60 * 60_000;

/** Callback data prefix for UI actions (operations use `o:`). */
export const UI_PREFIX = "u:";

/**
 * Collects buttons whose callback data is an opaque token; the action and its
 * payload stay on the server, bound to the user.
 */
export class ActionButtons {
  private readonly pending: { token: string; action: string; payload: Record<string, unknown> }[] =
    [];

  constructor(
    private readonly ids: IdGenerator,
    private readonly userId: string,
    private readonly now: number,
    private readonly ttlMs = UI_ACTION_TTL_MS,
  ) {}

  button(text: string, action: string, payload: Record<string, unknown>): InlineKeyboardButton {
    const token = this.ids.next();
    this.pending.push({ token, action, payload });
    return { text, callback_data: `${UI_PREFIX}${token}` };
  }

  statements(db: D1Database, guard: Guard): D1PreparedStatement[] {
    return this.pending.map((p) =>
      insertUiActionStatement(
        db,
        p.token,
        this.userId,
        { action: p.action, payload: p.payload },
        this.now + this.ttlMs,
        this.now,
        guard,
      ),
    );
  }
}
