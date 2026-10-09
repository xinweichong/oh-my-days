import { secretsEqual } from "../security/compare";

/**
 * Verifies Telegram Mini App `initData` (ADR 0005): HMAC-SHA256 over the sorted
 * `key=value` lines of every received field except `hash` (including
 * `signature`, which only the separate Ed25519 check leaves out), keyed with
 * HMAC-SHA256(bot token, "WebAppData"). Only the signed `user` field is
 * trusted; nothing from the client is used before this passes.
 */

/** Signed launch data older than this is refused. */
export const MAX_INIT_DATA_AGE_S = 60 * 60;
/** Clock skew tolerated for an `auth_date` slightly in the future. */
const FUTURE_SKEW_S = 60;
const MAX_LENGTH = 4096;

export type InitDataCheck =
  | { ok: true; telegramUserId: number; authDate: number }
  | { ok: false; reason: "missing" | "malformed" | "bad_hash" | "stale" | "no_user" };

const encoder = new TextEncoder();

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const imported = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", imported, encoder.encode(data));
}

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The data-check string the bot-token hash covers: every field but `hash`, sorted. */
export function dataCheckString(params: URLSearchParams): string {
  return [...params.entries()]
    .filter(([key]) => key !== "hash")
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join("\n");
}

export async function signInitData(
  fields: Record<string, string>,
  botToken: string,
): Promise<string> {
  const params = new URLSearchParams(fields);
  const secret = await hmac(encoder.encode("WebAppData"), botToken);
  params.set("hash", hex(await hmac(secret, dataCheckString(params))));
  return params.toString();
}

export async function verifyInitData(
  raw: string | null,
  botToken: string,
  nowMs: number,
): Promise<InitDataCheck> {
  if (!raw) return { ok: false, reason: "missing" };
  if (raw.length > MAX_LENGTH) return { ok: false, reason: "malformed" };
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(raw);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const hash = params.get("hash");
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return { ok: false, reason: "malformed" };

  const secret = await hmac(encoder.encode("WebAppData"), botToken);
  const expected = hex(await hmac(secret, dataCheckString(params)));
  if (!(await secretsEqual(expected, hash))) return { ok: false, reason: "bad_hash" };

  const authDate = Number(params.get("auth_date"));
  if (!Number.isInteger(authDate) || authDate <= 0) return { ok: false, reason: "malformed" };
  const nowS = Math.floor(nowMs / 1000);
  if (nowS - authDate > MAX_INIT_DATA_AGE_S || authDate - nowS > FUTURE_SKEW_S) {
    return { ok: false, reason: "stale" };
  }

  let id: unknown;
  try {
    id = (JSON.parse(params.get("user") ?? "null") as { id?: unknown } | null)?.id;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
    return { ok: false, reason: "no_user" };
  }
  return { ok: true, telegramUserId: id, authDate };
}
