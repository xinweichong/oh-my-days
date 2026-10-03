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
    const tampered = `${sealed.slice(0, -2)}${sealed.endsWith("A") ? "B" : "A"}=`;
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
