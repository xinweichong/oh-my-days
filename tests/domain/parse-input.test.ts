import { describe, expect, it } from "vitest";
import {
  parseDate,
  parseDuration,
  parseLocalDate,
  parseTime,
  parseTimeRange,
  parseWallTime,
} from "../../src/domain/parse-input";

const today = "2026-10-03"; // Saturday

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
  ])("keeps the existing form %s → %s", (input, expected) => {
    expect(parseLocalDate(input, today)).toBe(expected);
  });

  it.each(["31 Feb", "29/2/2027", "octopus 9", "2026-13-01", "", "someday", "in 0 days"])(
    "refuses %s",
    (input) => {
      expect(parseLocalDate(input, today)).toBeNull();
    },
  );

  it("accepts 29 February only in leap years", () => {
    expect(parseLocalDate("29 Feb", today)).toBe("2028-02-29");
  });

  it("is null when the answer is a choice", () => {
    expect(parseLocalDate("sat", today)).toBeNull();
  });
});

describe("parseDate: weekdays and relative dates", () => {
  // Fri 9 Oct 2026.
  const friday = "2026-10-09";

  it.each([
    ["mon", "2026-10-12"],
    ["Monday", "2026-10-12"],
    ["tues", "2026-10-13"],
    ["thursday", "2026-10-15"],
    ["on sat", "2026-10-10"],
    ["Sunday", "2026-10-11"],
    ["coming mon", "2026-10-12"],
  ])("a weekday is its next occurrence after today: %s → %s", (input, expected) => {
    expect(parseDate(input, friday)).toEqual({ date: expected });
  });

  it("asks between today and a week later on that weekday", () => {
    expect(parseDate("fri", friday)).toEqual({ choose: ["2026-10-09", "2026-10-16"] });
  });

  it("next <weekday> asks when the coming one and next week's differ", () => {
    // Wednesday 7 Oct: the coming Friday is the 9th, next week's is the 16th.
    expect(parseDate("next fri", "2026-10-07")).toEqual({
      choose: ["2026-10-09", "2026-10-16"],
    });
    // Friday 9 Oct: the coming Monday is next week's Monday, so no question.
    expect(parseDate("next monday", friday)).toEqual({ date: "2026-10-12" });
    // On a Friday, next Friday is a week away either way.
    expect(parseDate("next fri", friday)).toEqual({ date: "2026-10-16" });
  });

  it("this <weekday> is the one in the current Monday–Sunday week, refused once past", () => {
    expect(parseDate("this sun", friday)).toEqual({ date: "2026-10-11" });
    expect(parseDate("this fri", friday)).toEqual({ date: friday });
    expect(parseDate("this wed", friday)).toBeNull();
    // Sunday: the week started six days ago.
    expect(parseDate("this sunday", "2026-10-11")).toEqual({ date: "2026-10-11" });
    expect(parseDate("this mon", "2026-10-11")).toBeNull();
  });

  it.each([
    ["in 3 days", "2026-10-12"],
    ["in a day", "2026-10-10"],
    ["in 2 weeks", "2026-10-23"],
    ["in one week", "2026-10-16"],
    ["next week", "2026-10-12"],
    ["end of month", "2026-10-31"],
    ["end of the month", "2026-10-31"],
    ["EOM", "2026-10-31"],
    ["tonight", friday],
    ["Fri 9 Oct", "2026-10-09"],
    ["friday, 16 october", "2026-10-16"],
    ["Fri 16/10", "2026-10-16"],
    ["9th Oct", "2026-10-09"],
    ["Oct 9th", "2026-10-09"],
  ])("%s → %s", (input, expected) => {
    expect(parseDate(input, friday)).toEqual({ date: expected });
  });

  it("refuses a weekday that disagrees with the date", () => {
    expect(parseDate("Thu 9 Oct", friday)).toBeNull();
  });

  it("crosses month and year boundaries", () => {
    expect(parseDate("in 3 days", "2026-12-30")).toEqual({ date: "2027-01-02" });
    expect(parseDate("mon", "2026-12-31")).toEqual({ date: "2027-01-04" });
    expect(parseDate("next week", "2026-12-30")).toEqual({ date: "2027-01-04" });
    expect(parseDate("end of month", "2026-12-15")).toEqual({ date: "2026-12-31" });
    expect(parseDate("eom", "2028-02-10")).toEqual({ date: "2028-02-29" });
    expect(parseDate("eom", "2027-02-10")).toEqual({ date: "2027-02-28" });
  });

  it("counts calendar days across a daylight-saving change", () => {
    // Europe/London springs forward on Sun 29 Mar 2026; dates are zone-free.
    expect(parseDate("tomorrow", "2026-03-28")).toEqual({ date: "2026-03-29" });
    expect(parseDate("in 1 week", "2026-03-26")).toEqual({ date: "2026-04-02" });
    expect(parseDate("sun", "2026-03-26")).toEqual({ date: "2026-03-29" });
  });

  it("limits relative offsets to about a year", () => {
    expect(parseDate("in 60 weeks", friday)).toBeNull();
    expect(parseDate("in 366 days", friday)).toEqual({ date: "2027-10-10" });
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

describe("parseTime", () => {
  it("asks am or pm for a bare hour", () => {
    expect(parseTime("at 3")).toEqual({ choose: ["03:00", "15:00"] });
    expect(parseTime("3")).toEqual({ choose: ["03:00", "15:00"] });
    expect(parseTime("12")).toEqual({ choose: ["12:00", "00:00"] });
  });

  it("keeps 24-hour times unless asked to question unpadded ones", () => {
    expect(parseTime("at 3pm")).toEqual({ time: "15:00" });
    expect(parseTime("3:30")).toEqual({ time: "03:30" });
    expect(parseTime("3:30", { askUnpaddedClock: true })).toEqual({
      choose: ["03:30", "15:30"],
    });
    expect(parseTime("03:30", { askUnpaddedClock: true })).toEqual({ time: "03:30" });
  });

  it.each(["0", "13", "at", "3 apples"])("refuses %s", (input) => {
    expect(parseTime(input)).toBeNull();
  });
});

describe("parseTimeRange", () => {
  it.each([
    ["7-9pm", "19:00", "21:00"],
    ["7:30–9pm", "19:30", "21:00"],
    ["7pm to 9pm", "19:00", "21:00"],
    ["19:00–21:00", "19:00", "21:00"],
    ["11-1pm", "11:00", "13:00"],
    ["11am-1pm", "11:00", "13:00"],
    ["7pm-9", "19:00", "21:00"],
    ["from 10pm to 1am", "22:00", "01:00"],
    ["noon-2", "12:00", "14:00"],
    ["9am until noon", "09:00", "12:00"],
  ])("%s → %s–%s", (input, start, end) => {
    expect(parseTimeRange(input)).toEqual({ start, end });
  });

  it.each(["7-9", "2026-10-09", "7pm", "9pm-9pm", "13pm-2pm", "seven to nine"])(
    "refuses %s",
    (input) => {
      expect(parseTimeRange(input)).toBeNull();
    },
  );
});

describe("parseDuration", () => {
  it.each([
    ["30m", { minutes: 30 }],
    ["45 min", { minutes: 45 }],
    ["2 hours", { minutes: 120 }],
    ["two hours", { minutes: 120 }],
    ["an hour", { minutes: 60 }],
    ["half an hour", { minutes: 30 }],
    ["1.5h", { minutes: 90 }],
    ["1h30", { minutes: 90 }],
    ["until 9pm", { endTime: "21:00" }],
    ["21:30", { endTime: "21:30" }],
  ])("%s", (input, expected) => {
    expect(parseDuration(input)).toEqual(expected);
  });

  it.each(["0m", "zero hours", "1h75", "9999h", "many hours"])("refuses %s", (input) => {
    expect(parseDuration(input)).toBeNull();
  });
});
