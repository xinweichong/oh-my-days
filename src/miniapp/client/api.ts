import { telegram } from "./telegram";

/** Calls /app/api with the signed initData; errors carry the server's short code. */

export class ApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly body: Record<string, unknown> | null = null,
  ) {
    super(code);
  }
}

export async function api<T>(path: string, body?: Record<string, unknown>): Promise<T> {
  const tg = telegram();
  let response: Response;
  try {
    response = await fetch(`/app/api/${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        authorization: `tma ${tg?.initData ?? ""}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new ApiError("network", 0);
  }
  const parsed = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) {
    throw new ApiError(String(parsed?.error ?? "error"), response.status, parsed);
  }
  return parsed as T;
}

/** A fresh idempotency key per user action; a retried request reuses it. */
export function newKey(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c?.randomUUID) return c.randomUUID();
  return `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

/** A write with one automatic retry on a network failure, using the same key. */
export async function write<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const payload = { key: newKey(), ...body };
  try {
    return await api<T>(path, payload);
  } catch (error) {
    if (error instanceof ApiError && error.code === "network") return api<T>(path, payload);
    throw error;
  }
}

/** User-facing text for an error code. */
export function errorText(error: unknown): string {
  const code = error instanceof ApiError ? error.code : "error";
  switch (code) {
    case "expired":
      return "This window has been open for over an hour. Close it and open the app again from the chat.";
    case "unauthorized": {
      const reason =
        error instanceof ApiError && typeof error.body?.reason === "string"
          ? error.body.reason
          : "unknown";
      return `Sign-in was refused (${reason}). Close this and open the app again from the chat; if it repeats, send this code to the bot's owner.`;
    }
    case "setup_incomplete":
      return "Finish setup in the chat first.";
    case "network":
      return "Couldn't reach Oh My Days. Check your connection.";
    case "stale":
      return "This changed elsewhere. Showing the latest.";
    case "reconnect":
      return "Google Calendar needs reconnecting. Send /health in the chat.";
    case "time_skipped":
      return "That time doesn't exist on that day (clocks change). Choose another.";
    case "bad_snooze":
      return "Choose a time later than now.";
    case "bad_title":
      return "Enter a title of up to 200 characters.";
    default:
      return "Something went wrong. Nothing was changed.";
  }
}
