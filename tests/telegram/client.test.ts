import { describe, expect, it } from "vitest";
import { createTelegramClient } from "../../src/telegram/client";

const call = { method: "sendMessage", params: { chat_id: 1, text: "hi" } } as const;

function respond(status: number, body: unknown): typeof fetch {
  return async () => new Response(JSON.stringify(body), { status });
}

describe("Telegram client", () => {
  it("returns the sent message ID", async () => {
    const client = createTelegramClient(
      "secret-token",
      respond(200, { ok: true, result: { message_id: 42 } }),
    );
    expect(await client.call(call)).toEqual({ kind: "ok", messageId: 42 });
  });

  it("honours retry_after on rate limits", async () => {
    const client = createTelegramClient(
      "t",
      respond(429, { ok: false, parameters: { retry_after: 3 } }),
    );
    expect(await client.call(call)).toMatchObject({ kind: "retryable", retryAfterMs: 3000 });
  });

  it("treats server errors as retryable and client errors as permanent", async () => {
    expect(await createTelegramClient("t", respond(502, {})).call(call)).toMatchObject({
      kind: "retryable",
    });
    expect(await createTelegramClient("t", respond(403, { ok: false })).call(call)).toEqual({
      kind: "permanent",
      errorClass: "http_403",
    });
  });

  it("reports network failures as unknown outcomes without exposing the token", async () => {
    const client = createTelegramClient("secret-token", async (input) => {
      throw new TypeError(`fetch failed for ${String(input)}`);
    });
    const result = await client.call(call);
    expect(result).toEqual({ kind: "unknown", errorClass: "network" });
    expect(JSON.stringify(result)).not.toContain("secret-token");
  });

  it("uploads documents as multipart form data", async () => {
    let sent: RequestInit | undefined;
    let url = "";
    const client = createTelegramClient("t", async (input, init) => {
      url = String(input);
      sent = init;
      return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }));
    });
    const result = await client.call({
      method: "sendDocument",
      params: {
        chat_id: 5,
        caption: "Your data",
        document: { filename: "export.json", content: '{"a":1}', mime_type: "application/json" },
      },
    });
    expect(result).toEqual({ kind: "ok", messageId: 7 });
    expect(url.endsWith("/sendDocument")).toBe(true);
    const form = sent?.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("chat_id")).toBe("5");
    expect(form.get("caption")).toBe("Your data");
    const file = form.get("document") as File;
    expect(file.name).toBe("export.json");
    expect(await file.text()).toBe('{"a":1}');
  });
});
