import { describe, expect, it } from "vitest";
import {
  agendaDueDate,
  isDueOn,
  isOverdue,
  monthStart,
  nextMonthStart,
  previousMonthStart,
  weekStart,
} from "../../src/domain/schedule";

const SG = "Asia/Singapore";

describe("deadline rules", () => {
  it("makes a date-only task overdue only after its date ends in the user's zone", () => {
    const deadline = { kind: "date" as const, date: "2026-09-25" };
    expect(isOverdue(deadline, Date.UTC(2026, 8, 25, 15, 59), SG)).toBe(false); // 23:59 SGT
    expect(isOverdue(deadline, Date.UTC(2026, 8, 25, 16, 0), SG)).toBe(true); // 00:00 SGT next day
  });

  it("makes an exact-time task overdue after its instant", () => {
    const at = Date.UTC(2026, 8, 25, 7);
    const deadline = { kind: "datetime" as const, at, timeZone: SG };
    expect(isOverdue(deadline, at, SG)).toBe(false);
    expect(isOverdue(deadline, at + 1, SG)).toBe(true);
  });

  it("places exact-time deadlines on the user's local date", () => {
    const lateFriday = { kind: "datetime" as const, at: Date.UTC(2026, 8, 25, 17), timeZone: SG }; // 01:00 Sat SGT
    expect(isDueOn(lateFriday, "2026-09-26", SG)).toBe(true);
    expect(isDueOn(lateFriday, "2026-09-25", "Europe/London")).toBe(true);
  });
});

describe("calendar periods", () => {
  it("uses Monday–Sunday weeks", () => {
    expect(weekStart("2026-09-27")).toBe("2026-09-21"); // Sunday → Monday before
    expect(weekStart("2026-09-21")).toBe("2026-09-21");
    expect(weekStart("2026-01-01")).toBe("2025-12-29"); // across years
  });

  it("navigates months across year boundaries", () => {
    expect(monthStart("2026-09-27")).toBe("2026-09-01");
    expect(nextMonthStart("2026-12-15")).toBe("2027-01-01");
    expect(previousMonthStart("2026-01-15")).toBe("2025-12-01");
  });
});

describe("agenda timing", () => {
  it("is due from 8am local time, for that local date", () => {
    expect(agendaDueDate(Date.UTC(2026, 8, 24, 23, 59), SG)).toBeNull(); // 07:59 SGT
    expect(agendaDueDate(Date.UTC(2026, 8, 25, 0, 0), SG)).toBe("2026-09-25"); // 08:00 SGT
  });

  it("follows daylight saving in the user's zone", () => {
    // 8am in London is 07:00 UTC in summer and 08:00 UTC in winter.
    expect(agendaDueDate(Date.UTC(2026, 6, 1, 7, 0), "Europe/London")).toBe("2026-07-01");
    expect(agendaDueDate(Date.UTC(2026, 11, 1, 7, 30), "Europe/London")).toBeNull();
    expect(agendaDueDate(Date.UTC(2026, 11, 1, 8, 0), "Europe/London")).toBe("2026-12-01");
  });
});
