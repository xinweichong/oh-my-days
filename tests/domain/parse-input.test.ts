import { describe, expect, it } from "vitest";
import { parseDuration, parseLocalDate, parseWallTime } from "../../src/domain/parse-input";

const today = "2026-10-03";

describe("parseLocalDate", () => {
  it.each([
    ["today", "2026-10-03"],
    ["Tomorrow", "2026-10-04"],
    ["2026-10-09", "2026-10-09"],
    ["9 Oct", "2026-10-09"],
    ["9 October 2027", "2027-10-09"],
    ["Oct 9", "2026-10-09"],
    ["9/10", "2026-10-09"],
    ["9/10/2026", "2026-10-09"],
    ["1 Jan", "2027-01-01"], // already passed this year
    ["3 Oct", "2026-10-03"], // today counts as upcoming
  ])("%s → %s", (input, expected) => {
    expect(parseLocalDate(input, today)).toBe(expected);
  });

  it.each(["31 Feb", "29/2/2027", "next friday", "octopus 9", "2026-13-01", "", "friday"])(
    "refuses %s",
    (input) => {
      expect(parseLocalDate(input, today)).toBeNull();
    },
  );

  it("accepts 29 February only in leap years", () => {
    expect(parseLocalDate("29 Feb", today)).toBe("2028-02-29");
  });
});

describe("parseWallTime", () => {
  it.each([
    ["19:00", "19:00"],
    ["7:05", "07:05"],
    ["7pm", "19:00"],
    ["7:30 PM", "19:30"],
    ["12am", "00:00"],
    ["12pm", "12:00"],
    ["noon", "12:00"],
  ])("%s → %s", (input, expected) => {
    expect(parseWallTime(input)).toBe(expected);
  });

  it.each(["24:00", "13pm", "7", "seven", "19:60"])("refuses %s", (input) => {
    expect(parseWallTime(input)).toBeNull();
  });
});

describe("parseDuration", () => {
  it.each([
    ["30m", { minutes: 30 }],
    ["45 min", { minutes: 45 }],
    ["2 hours", { minutes: 120 }],
    ["1.5h", { minutes: 90 }],
    ["1h30", { minutes: 90 }],
    ["until 9pm", { endTime: "21:00" }],
    ["21:30", { endTime: "21:30" }],
  ])("%s", (input, expected) => {
    expect(parseDuration(input)).toEqual(expected);
  });

  it.each(["0m", "two hours", "1h75", "9999h"])("refuses %s", (input) => {
    expect(parseDuration(input)).toBeNull();
  });
});
