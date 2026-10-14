import { describe, expect, it } from "vitest";
import {
  describeRecurrence,
  firstOccurrence,
  occurrencesBetween,
  parseRepeatInterval,
  toRRule,
} from "../../src/domain/recurrence";

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
    expect(toRRule({ freq: "weekly", interval: 1 })).toBe("RRULE:FREQ=WEEKLY");
    expect(toRRule({ freq: "monthly", interval: 2 })).toBe("RRULE:FREQ=MONTHLY;INTERVAL=2");
    expect(toRRule({ freq: "daily", interval: 1, by: "weekdays" })).toBe(
      "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR",
    );
    expect(toRRule({ freq: "monthly", interval: 3, by: "last_day" })).toBe(
      "RRULE:FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=-1",
    );
  });
});

describe("more repeat rules (D3)", () => {
  it("repeats every N days, weeks, and months", () => {
    expect(
      occurrencesBetween(
        { freq: "daily", interval: 3, anchor: "2026-10-01" },
        "2026-10-01",
        "2026-10-10",
        10,
      ),
    ).toEqual(["2026-10-01", "2026-10-04", "2026-10-07", "2026-10-10"]);
    expect(
      occurrencesBetween(
        { freq: "weekly", interval: 2, anchor: "2026-10-05" },
        "2026-10-06",
        "2026-11-03",
        10,
      ),
    ).toEqual(["2026-10-19", "2026-11-02"]);
    expect(
      occurrencesBetween(
        { freq: "monthly", interval: 6, anchor: "2026-01-15" },
        "2026-01-01",
        "2027-12-31",
        10,
      ),
    ).toEqual(["2026-01-15", "2026-07-15", "2027-01-15", "2027-07-15"]);
  });

  it("repeats on weekdays only", () => {
    const rule = {
      freq: "daily" as const,
      interval: 1,
      anchor: "2026-10-09",
      by: "weekdays" as const,
    };
    expect(occurrencesBetween(rule, "2026-10-09", "2026-10-14", 10)).toEqual([
      "2026-10-09",
      "2026-10-12",
      "2026-10-13",
      "2026-10-14",
    ]);
    // Chosen on a Saturday: the first occurrence is Monday.
    expect(firstOccurrence({ ...rule, anchor: "2026-10-10" })).toBe("2026-10-12");
    expect(describeRecurrence(rule)).toBe("Every weekday (Monday to Friday)");
  });

  it("repeats on the last day of the month, including February in leap years", () => {
    const rule = {
      freq: "monthly" as const,
      interval: 1,
      anchor: "2027-12-15",
      by: "last_day" as const,
    };
    expect(occurrencesBetween(rule, "2027-12-01", "2028-04-30", 10)).toEqual([
      "2027-12-31",
      "2028-01-31",
      "2028-02-29",
      "2028-03-31",
      "2028-04-30",
    ]);
    expect(firstOccurrence(rule)).toBe("2027-12-31");
    expect(describeRecurrence({ ...rule, interval: 2 })).toBe("Every 2 months on the last day");
    expect(occurrencesBetween({ ...rule, interval: 2 }, "2027-12-01", "2028-06-30", 10)).toEqual([
      "2027-12-31",
      "2028-02-29",
      "2028-04-30",
      "2028-06-30",
    ]);
  });

  it.each([
    ["every 2 weeks", { freq: "weekly", interval: 2 }],
    ["3 days", { freq: "daily", interval: 3 }],
    ["Every 6 months", { freq: "monthly", interval: 6 }],
    ["every 1 day", { freq: "daily", interval: 1 }],
  ])("reads %s", (input, expected) => {
    expect(parseRepeatInterval(input)).toEqual(expected);
  });

  it.each(["every 0 days", "every 100 weeks", "fortnightly", "every 2 years", "2"])(
    "refuses %s",
    (input) => {
      expect(parseRepeatInterval(input)).toBeNull();
    },
  );
});
