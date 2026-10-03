import { describe, expect, it } from "vitest";
import {
  deadlineFromMarker,
  desiredMarker,
  markerTitle,
  normalizeListName,
  parseMarkerTitle,
} from "../../src/domain/tasks";

const SG = "Asia/Singapore";

describe("task markers", () => {
  it("annotates the list, and marks completion with a leading ✓", () => {
    const task = { title: "Submit expenses", listName: "Work", status: "open" as const };
    expect(markerTitle(task)).toBe("[Work] Submit expenses");
    expect(markerTitle({ ...task, status: "completed" })).toBe("✓ [Work] Submit expenses");
  });

  it("projects a date-only deadline as an all-day marker on that date", () => {
    expect(
      desiredMarker({
        title: "Buy milk",
        listName: "Inbox",
        status: "open",
        deadline: { kind: "date", date: "2026-09-26" },
      }),
    ).toEqual({
      summary: "[Inbox] Buy milk",
      start: { date: "2026-09-26" },
      end: { date: "2026-09-27" },
    });
  });

  it("projects an exact deadline as a zero-length marker preserving the time", () => {
    const marker = desiredMarker({
      title: "Send report",
      listName: "Work",
      status: "open",
      deadline: { kind: "datetime", at: Date.UTC(2026, 8, 26, 7, 0), timeZone: SG },
    });
    expect(marker?.start).toEqual({ dateTime: "2026-09-26T15:00:00+08:00", timeZone: SG });
    expect(marker?.end).toEqual(marker?.start);
  });

  it("has no marker without a deadline or once cancelled", () => {
    const base = {
      title: "x",
      listName: "Inbox",
      deadline: { kind: "date" as const, date: "2026-09-26" },
    };
    expect(desiredMarker({ ...base, status: "cancelled" })).toBeNull();
    expect(desiredMarker({ ...base, status: "open", deadline: { kind: "none" } })).toBeNull();
  });

  it("reads completion and known list annotations from edited markers", () => {
    const lists = ["Inbox", "Work"];
    expect(parseMarkerTitle("✓ [work] Submit expenses", lists)).toEqual({
      title: "Submit expenses",
      completed: true,
      listName: "Work",
    });
    expect(parseMarkerTitle("Call the bank", lists)).toEqual({
      title: "Call the bank",
      completed: false,
      listName: null,
    });
  });

  it("keeps an unknown annotation in the title rather than inventing a list", () => {
    expect(parseMarkerTitle("[Garden] Plant bulbs", ["Inbox"])).toEqual({
      title: "[Garden] Plant bulbs",
      completed: false,
      listName: null,
    });
  });

  it("reads deadlines back from markers without turning dates into instants", () => {
    expect(deadlineFromMarker({ date: "2026-09-26" })).toEqual({
      kind: "date",
      date: "2026-09-26",
    });
    expect(deadlineFromMarker({ dateTime: "2026-09-26T15:00:00+08:00", timeZone: SG })).toEqual({
      kind: "datetime",
      at: Date.UTC(2026, 8, 26, 7),
      timeZone: SG,
    });
  });

  it("normalizes list names for comparison", () => {
    expect(normalizeListName("  Work   Stuff ")).toBe("work stuff");
  });
});
