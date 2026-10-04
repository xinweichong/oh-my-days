import { describe, expect, it } from "vitest";
import { parseFollowUp } from "../../src/domain/follow-up";

const today = "2026-09-25";

describe("parseFollowUp", () => {
  it.each([
    ["Move it to 4pm", { kind: "move", date: null, time: "16:00" }],
    ["move to tomorrow", { kind: "move", date: "2026-09-26", time: null }],
    ["Reschedule it to 9 Oct 10:30", { kind: "move", date: "2026-10-09", time: "10:30" }],
    ["rename it to Dinner with Sam", { kind: "rename", title: "Dinner with Sam" }],
    ["Delete it", { kind: "delete" }],
    ["cancel", { kind: "delete" }],
    ["done", { kind: "done" }],
    ["Mark it as done", { kind: "done" }],
  ])("%s", (input, expected) => {
    expect(parseFollowUp(input, today)).toEqual(expected);
  });

  it.each([
    "Move it somewhere nice",
    "Dinner Friday at 7pm",
    "delete everything",
    "make that Friday",
  ])("does not guess: %s", (input) => {
    expect(parseFollowUp(input, today)).toBeNull();
  });
});
