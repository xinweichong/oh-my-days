import { describe, expect, it } from "vitest";
import { retryDelayMs } from "../../src/domain/retry";

const policy = { baseMs: 1000, maxMs: 60_000 };

describe("retryDelayMs", () => {
  it("grows exponentially up to the cap, with full jitter", () => {
    expect(retryDelayMs(1, policy, () => 0.999)).toBe(999);
    expect(retryDelayMs(3, policy, () => 0.999)).toBe(3996);
    expect(retryDelayMs(20, policy, () => 0.999)).toBe(59_940);
    expect(retryDelayMs(3, policy, () => 0)).toBe(1);
  });

  it("never retries sooner than the provider's hint", () => {
    expect(retryDelayMs(1, policy, () => 0, 30_000)).toBe(30_000);
  });
});
