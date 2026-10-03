import { describe, expect, it } from "vitest";
import { addDays, localDateAt, rfc3339, weekday, zonedInstant } from "../../src/domain/time";

describe("zoned time", () => {
  it("converts Singapore wall time to an instant and back", () => {
    const result = zonedInstant("2026-10-09", "19:00", "Asia/Singapore");
    expect(result).toEqual({ ok: true, instant: Date.UTC(2026, 9, 9, 11, 0), offsetMinutes: 480 });
    if (result.ok)
      expect(rfc3339(result.instant, "Asia/Singapore")).toBe("2026-10-09T19:00:00+08:00");
  });

  it("follows daylight saving in other zones", () => {
    const summer = zonedInstant("2026-07-01", "09:00", "Europe/London");
    const winter = zonedInstant("2026-12-01", "09:00", "Europe/London");
    expect(summer).toMatchObject({ ok: true, offsetMinutes: 60 });
    expect(winter).toMatchObject({ ok: true, offsetMinutes: 0 });
  });

  it("refuses a wall time skipped by the spring-forward transition", () => {
    // London clocks jump from 01:00 to 02:00 on 29 March 2026.
    expect(zonedInstant("2026-03-29", "01:30", "Europe/London")).toEqual({
      ok: false,
      reason: "nonexistent",
    });
  });

  it("chooses the earlier instant when the fall-back transition repeats a time", () => {
    // London clocks go from 02:00 BST back to 01:00 GMT on 25 October 2026.
    const result = zonedInstant("2026-10-25", "01:30", "Europe/London");
    expect(result).toEqual({ ok: true, instant: Date.UTC(2026, 9, 25, 0, 30), offsetMinutes: 60 });
  });

  it("does calendar arithmetic on local dates without a zone", () => {
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29"); // leap year
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(weekday("2026-10-05")).toBe(1); // Monday
  });

  it("reads the local date of an instant in the user's zone", () => {
    const instant = Date.UTC(2026, 9, 9, 17, 0); // 01:00 on the 10th in Singapore
    expect(localDateAt(instant, "Asia/Singapore")).toBe("2026-10-10");
    expect(localDateAt(instant, "Europe/London")).toBe("2026-10-09");
  });
});
