import { describe, expect, it } from "vitest";
import { describeRecurrence, occurrencesBetween, toRRule } from "../../src/domain/recurrence";

describe("recurrence", () => {
  it("repeats daily and weekly from the anchor", () => {
    expect(
      occurrencesBetween(
        { freq: "daily", interval: 1, anchor: "2026-09-28" },
        "2026-09-27",
        "2026-10-01",
        10,
      ),
    ).toEqual(["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01"]);
    expect(
      occurrencesBetween(
        { freq: "weekly", interval: 2, anchor: "2026-09-07" },
        "2026-09-20",
        "2026-10-31",
        10,
      ),
    ).toEqual(["2026-09-21", "2026-10-05", "2026-10-19"]);
  });

  it("skips months without the anchor day instead of clamping", () => {
    expect(
      occurrencesBetween(
        { freq: "monthly", interval: 1, anchor: "2026-08-31" },
        "2026-08-01",
        "2027-01-31",
        10,
      ),
    ).toEqual(["2026-08-31", "2026-10-31", "2026-12-31", "2027-01-31"]);
  });

  it("puts 29 February only in leap years", () => {
    expect(
      occurrencesBetween(
        { freq: "yearly", interval: 1, anchor: "2028-02-29" },
        "2028-01-01",
        "2036-12-31",
        10,
      ),
    ).toEqual(["2028-02-29", "2032-02-29", "2036-02-29"]);
  });

  it("stops at the limit", () => {
    expect(
      occurrencesBetween(
        { freq: "daily", interval: 1, anchor: "2026-01-01" },
        "2026-01-01",
        "2026-12-31",
        3,
      ),
    ).toHaveLength(3);
  });

  it("states the interpreted schedule, including skipped dates", () => {
    expect(describeRecurrence({ freq: "monthly", interval: 1, anchor: "2026-08-31" })).toBe(
      "Every month on the 31st (months without a 31st are skipped)",
    );
    expect(describeRecurrence({ freq: "yearly", interval: 1, anchor: "2028-02-29" })).toBe(
      "Every year on 29 February (only in leap years)",
    );
    expect(describeRecurrence({ freq: "weekly", interval: 1, anchor: "2026-09-28" })).toBe(
      "Every week on Monday",
    );
    expect(describeRecurrence({ freq: "monthly", interval: 1, anchor: "2026-09-01" })).toBe(
      "Every month on the 1st",
    );
  });

  it("produces matching RRULEs for events", () => {
    expect(toRRule("weekly")).toBe("RRULE:FREQ=WEEKLY");
    expect(toRRule("monthly", 2)).toBe("RRULE:FREQ=MONTHLY;INTERVAL=2");
  });
});
