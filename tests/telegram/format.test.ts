import { describe, expect, it } from "vitest";
import { formatEventRange } from "../../src/telegram/format";

const sg = "Asia/Singapore";
const at = (local: string) => ({ dateTime: `${local}+08:00`, timeZone: sg });

describe("formatEventRange", () => {
  it("shows the complete interpreted range (spec §5)", () => {
    expect(
      formatEventRange({ start: at("2026-09-25T19:00:00"), end: at("2026-09-25T20:00:00") }, sg),
    ).toBe("Fri 25 Sep 2026, 7–8pm");
  });

  it("includes minutes and both meridiems when needed", () => {
    expect(
      formatEventRange({ start: at("2026-09-25T11:30:00"), end: at("2026-09-25T12:15:00") }, sg),
    ).toBe("Fri 25 Sep 2026, 11:30am–12:15pm");
  });

  it("spans midnight explicitly", () => {
    expect(
      formatEventRange({ start: at("2026-09-25T23:00:00"), end: at("2026-09-26T01:00:00") }, sg),
    ).toBe("Fri 25 Sep 2026, 11pm – Sat 26 Sep, 1am");
  });

  it("renders in the user's timezone", () => {
    expect(
      formatEventRange(
        { start: at("2026-09-25T19:00:00"), end: at("2026-09-25T20:00:00") },
        "Europe/London",
      ),
    ).toBe("Fri 25 Sep 2026, 12–1pm");
  });

  it("treats all-day end dates as exclusive", () => {
    expect(
      formatEventRange({ start: { date: "2026-09-25" }, end: { date: "2026-09-26" } }, sg),
    ).toBe("Fri 25 Sep 2026 (all day)");
    expect(
      formatEventRange({ start: { date: "2026-09-25" }, end: { date: "2026-09-28" } }, sg),
    ).toBe("Fri 25 – Sun 27 Sep 2026 (all day)");
  });
});
