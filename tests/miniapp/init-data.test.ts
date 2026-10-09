import { describe, expect, it } from "vitest";
import { dataCheckString, signInitData, verifyInitData } from "../../src/miniapp/init-data";

const TOKEN = "test-bot-token";
const NOW = Date.UTC(2026, 9, 10, 1, 0, 0);
const nowS = Math.floor(NOW / 1000);

function fields(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    auth_date: String(nowS - 60),
    query_id: "AAH-synthetic",
    user: JSON.stringify({ id: 1001, first_name: "Test", language_code: "en" }),
    ...overrides,
  };
}

describe("initData verification (ADR 0005)", () => {
  it("accepts data signed with the bot token and returns the signed user", async () => {
    const raw = await signInitData(fields(), TOKEN);
    expect(await verifyInitData(raw, TOKEN, NOW)).toEqual({
      ok: true,
      telegramUserId: 1001,
      authDate: nowS - 60,
    });
  });

  it("builds the data-check string from every field but hash, signature included", () => {
    // Telegram's reference: "a chain of all received fields"; only the Ed25519
    // third-party check leaves out signature. Current clients send one.
    const params = new URLSearchParams({ user: "u", hash: "h", auth_date: "1", signature: "s" });
    expect(dataCheckString(params)).toBe("auth_date=1\nsignature=s\nuser=u");
  });

  it("accepts launch data signed as Telegram documents it, signature field included", async () => {
    // Signed independently of the code under test, straight from the reference:
    // hex(HMAC_SHA256(data_check_string, HMAC_SHA256("WebAppData" key, bot_token))).
    const sent = { ...fields(), signature: "c2lnbmF0dXJlLWJ5dGVz" };
    const check = Object.entries(sent)
      .map(([k, v]) => `${k}=${v}`)
      .sort()
      .join("\n");
    const hmac = async (key: BufferSource, data: string) =>
      crypto.subtle.sign(
        "HMAC",
        await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, [
          "sign",
        ]),
        new TextEncoder().encode(data),
      );
    const secret = await hmac(new TextEncoder().encode("WebAppData"), TOKEN);
    const hash = [...new Uint8Array(await hmac(secret, check))]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const raw = new URLSearchParams({ ...sent, hash }).toString();
    expect((await verifyInitData(raw, TOKEN, NOW)).ok).toBe(true);
    const changed = raw.replace("c2lnbmF0dXJlLWJ5dGVz", "b3RoZXItYnl0ZXM");
    expect(await verifyInitData(changed, TOKEN, NOW)).toEqual({ ok: false, reason: "bad_hash" });
  });

  it("refuses a changed field, another bot's signature, or a missing hash", async () => {
    const raw = await signInitData(fields(), TOKEN);
    const tampered = raw.replace("1001", "1002");
    expect(await verifyInitData(tampered, TOKEN, NOW)).toEqual({ ok: false, reason: "bad_hash" });
    const otherBot = await signInitData(fields(), "another-bot-token");
    expect(await verifyInitData(otherBot, TOKEN, NOW)).toEqual({ ok: false, reason: "bad_hash" });
    const noHash = new URLSearchParams(raw);
    noHash.delete("hash");
    expect(await verifyInitData(noHash.toString(), TOKEN, NOW)).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(await verifyInitData(null, TOKEN, NOW)).toEqual({ ok: false, reason: "missing" });
    expect(await verifyInitData("", TOKEN, NOW)).toEqual({ ok: false, reason: "missing" });
  });

  it("refuses data older than an hour or from the future", async () => {
    const old = await signInitData(fields({ auth_date: String(nowS - 3601) }), TOKEN);
    expect(await verifyInitData(old, TOKEN, NOW)).toEqual({ ok: false, reason: "stale" });
    const atLimit = await signInitData(fields({ auth_date: String(nowS - 3600) }), TOKEN);
    expect((await verifyInitData(atLimit, TOKEN, NOW)).ok).toBe(true);
    const future = await signInitData(fields({ auth_date: String(nowS + 120) }), TOKEN);
    expect(await verifyInitData(future, TOKEN, NOW)).toEqual({ ok: false, reason: "stale" });
  });

  it("refuses signed data without a user (keyboard-button launches send none)", async () => {
    const raw = await signInitData({ auth_date: String(nowS) }, TOKEN);
    expect(await verifyInitData(raw, TOKEN, NOW)).toEqual({ ok: false, reason: "no_user" });
  });
});
