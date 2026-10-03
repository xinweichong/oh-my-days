import { canonicalJson } from "../domain/field-merge";
import type { Clock } from "../shared/clock";
import { sha256Hex } from "../shared/hash";
import type { IdGenerator } from "../shared/ids";
import { insertCallbackRefStatement } from "../storage/callback-refs";
import { allOf, type Guard } from "../storage/guard";
import { insertOperationStatement } from "../storage/operations";
import type { UserRecord } from "../storage/users";
import type { InlineKeyboardMarkup, TelegramCall } from "../telegram/api";
import type { Preview, Proposal } from "./operation-types";

/** Unanswered confirmations expire (backend plan §7). */
export const CONFIRMATION_TTL_MS = 10 * 60_000;

export interface ProposalDeps {
  clock: Clock;
  ids: IdGenerator;
}

export interface PreparedProposal {
  operationId: string;
  /** Commit with the guard of the surrounding unit of work (e.g. inbox lease). */
  statements(db: D1Database, guard: Guard): D1PreparedStatement[];
  /** The confirmation prompt, if one is required. */
  replies: TelegramCall[];
}

export async function previewHash(
  kind: string,
  intent: unknown,
  preview: Preview,
): Promise<string> {
  return sha256Hex(canonicalJson({ kind, intent, facts: preview.facts, text: preview.text }));
}

/** Callback data format: `o:` + an opaque token (fits Telegram's 64-byte limit). */
export function callbackData(token: string): string {
  return `o:${token}`;
}

export function parseCallbackData(data: string | null): string | null {
  // Tokens are opaque; the server-side lookup (owner, expiry, use) is the check.
  const match = /^o:([0-9a-z]{1,40})$/.exec(data ?? "");
  return match?.[1] ?? null;
}

export function confirmationKeyboard(
  confirmToken: string,
  cancelToken: string,
  confirmLabel: string,
): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: confirmLabel, callback_data: callbackData(confirmToken) },
        { text: "Cancel", callback_data: callbackData(cancelToken) },
      ],
    ],
  };
}

/**
 * Turns a proposal into an operation. Changes that need confirmation wait for it;
 * others are ready to run immediately. Both paths use the same pipeline.
 */
export async function prepareProposal(
  deps: ProposalDeps,
  user: UserRecord,
  proposal: Proposal,
): Promise<PreparedProposal> {
  const now = deps.clock.now();
  const operationId = deps.ids.next();
  const preview = proposal.confirmation;

  if (!preview) {
    return {
      operationId,
      replies: [],
      statements: (db, guard) => [
        insertOperationStatement(
          db,
          {
            id: operationId,
            userId: user.id,
            kind: proposal.kind,
            idempotencyKey: proposal.idempotencyKey,
            intent: proposal.intent,
            status: "ready",
            preview: null,
            previewHash: null,
            confirmationExpiresAt: null,
          },
          now,
          guard,
        ),
      ],
    };
  }

  const hash = await previewHash(proposal.kind, proposal.intent, preview);
  const expiresAt = now + CONFIRMATION_TTL_MS;
  const confirmToken = deps.ids.next();
  const cancelToken = deps.ids.next();
  return {
    operationId,
    replies: [
      {
        method: "sendMessage",
        params: {
          chat_id: user.privateChatId,
          text: preview.text,
          reply_markup: confirmationKeyboard(confirmToken, cancelToken, preview.confirmLabel),
        },
      },
    ],
    statements: (db, guard) => {
      // Tokens are written only if this call created the operation.
      const created = allOf(guard, operationExists(operationId, user.id));
      return [
        insertOperationStatement(
          db,
          {
            id: operationId,
            userId: user.id,
            kind: proposal.kind,
            idempotencyKey: proposal.idempotencyKey,
            intent: proposal.intent,
            status: "awaiting_confirmation",
            preview,
            previewHash: hash,
            confirmationExpiresAt: expiresAt,
          },
          now,
          guard,
        ),
        ...[
          [confirmToken, "confirm"],
          [cancelToken, "cancel"],
        ].map(([token, action]) =>
          insertCallbackRefStatement(
            db,
            {
              token: token as string,
              userId: user.id,
              operationId,
              action: action as "confirm" | "cancel",
              previewHash: hash,
              expiresAt,
            },
            now,
            created,
          ),
        ),
      ];
    },
  };
}

export function operationExists(operationId: string, userId: string): Guard {
  return {
    sql: "EXISTS (SELECT 1 FROM operations WHERE id = ? AND user_id = ?)",
    params: [operationId, userId],
  };
}
