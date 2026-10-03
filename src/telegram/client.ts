import type { TelegramAdminCall, TelegramCall } from "./api";

export type TelegramResult =
  | { kind: "ok"; messageId: number | null }
  | { kind: "retryable"; retryAfterMs: number | null; errorClass: string }
  /** The request may have reached Telegram; its effect is unknown. */
  | { kind: "unknown"; errorClass: string }
  | { kind: "permanent"; errorClass: string };

export interface TelegramClient {
  call(call: TelegramCall | TelegramAdminCall): Promise<TelegramResult>;
}

const TIMEOUT_MS = 8_000;

/**
 * Bot API adapter. The token is part of the URL, so neither the URL nor raw
 * fetch errors are ever logged or returned; results carry an error class only.
 */
export function createTelegramClient(
  token: string,
  fetchImpl: typeof fetch = fetch,
): TelegramClient {
  return {
    async call({ method, params }) {
      let response: Response;
      try {
        response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(params),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (error) {
        const name = error instanceof Error ? error.name : "unknown";
        return { kind: "unknown", errorClass: name === "TimeoutError" ? "timeout" : "network" };
      }
      return classify(response);
    },
  };
}

async function classify(response: Response): Promise<TelegramResult> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // Non-JSON bodies are classified by status alone.
  }
  const json = (typeof body === "object" && body !== null ? body : {}) as {
    ok?: unknown;
    result?: { message_id?: unknown };
    parameters?: { retry_after?: unknown };
  };

  if (response.ok && json.ok === true) {
    const id = json.result?.message_id;
    return { kind: "ok", messageId: typeof id === "number" ? id : null };
  }
  if (response.status === 429) {
    const after = json.parameters?.retry_after;
    return {
      kind: "retryable",
      retryAfterMs: typeof after === "number" ? after * 1000 : null,
      errorClass: "rate_limited",
    };
  }
  if (response.status >= 500) {
    return { kind: "retryable", retryAfterMs: null, errorClass: `http_${response.status}` };
  }
  if (response.ok) {
    // 2xx without ok:true is not a documented response; do not assume either outcome.
    return { kind: "unknown", errorClass: "unexpected_response" };
  }
  return { kind: "permanent", errorClass: `http_${response.status}` };
}
