import { describe, expect, it } from "vitest";
import { ConfigError } from "../../src/env";
import { createTokenCipher } from "../../src/security/token-cipher";

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const OTHER_KEY = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=";

describe("token cipher", () => {
  it("round-trips and never stores the plaintext", async () => {
    const cipher = await createTokenCipher(KEY);
    const sealed = await cipher.encrypt("refresh-abc", { userId: "u1", purpose: "refresh_token" });
    expect(sealed).toMatch(/^v1\./);
    expect(sealed).not.toContain("refresh-abc");
    expect(await cipher.decrypt(sealed, { userId: "u1", purpose: "refresh_token" })).toBe(
      "refresh-abc",
    );
  });

  it("refuses a token moved to another user or column", async () => {
    const cipher = await createTokenCipher(KEY);
    const sealed = await cipher.encrypt("refresh-abc", { userId: "u1", purpose: "refresh_token" });
    await expect(
      cipher.decrypt(sealed, { userId: "u2", purpose: "refresh_token" }),
    ).rejects.toThrow();
    await expect(
      cipher.decrypt(sealed, { userId: "u1", purpose: "access_token" }),
    ).rejects.toThrow();
  });

  it("refuses tampered data and other keys", async () => {
    const cipher = await createTokenCipher(KEY);
    const sealed = await cipher.encrypt("x", { userId: "u1", purpose: "access_token" });
    // Flip one bit of the decoded bytes; changing a final base64 character can
    // touch only padding bits and leave the data unchanged.
    const prefix = sealed.slice(0, sealed.lastIndexOf(".") + 1);
    const bytes = Uint8Array.from(atob(sealed.slice(prefix.length)), (c) => c.charCodeAt(0));
    const middle = Math.floor(bytes.length / 2);
    bytes[middle] = (bytes[middle] ?? 0) ^ 1;
    const tampered = `${prefix}${btoa(String.fromCharCode(...bytes))}`;
    await expect(
      cipher.decrypt(tampered, { userId: "u1", purpose: "access_token" }),
    ).rejects.toThrow();
    const other = await createTokenCipher(OTHER_KEY);
    await expect(
      other.decrypt(sealed, { userId: "u1", purpose: "access_token" }),
    ).rejects.toThrow();
  });

  it("rejects keys that are not 32 bytes", async () => {
    await expect(createTokenCipher("c2hvcnQ=")).rejects.toBeInstanceOf(ConfigError);
  });
});
