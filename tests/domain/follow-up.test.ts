import { describe, expect, it } from "vitest";
import { parseFollowUp } from "../../src/domain/follow-up";

const today = "2026-09-25"; // Friday

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
    ["make that Monday", { kind: "move", date: "2026-09-28", time: null }],
    ["Actually, make that Monday.", { kind: "move", date: "2026-09-28", time: null }],
    ["make it 4pm", { kind: "move", date: null, time: "16:00" }],
    ["move it to Mon at 10am", { kind: "move", date: "2026-09-28", time: "10:00" }],
    ["move it to 10am next Monday", { kind: "move", date: "2026-09-28", time: "10:00" }],
    ["push it in 2 days", { kind: "move", date: "2026-09-27", time: null }],
  ])("%s", (input, expected) => {
    expect(parseFollowUp(input, today)).toEqual(expected);
  });

  it.each([
    "Move it somewhere nice",
    "Dinner Friday at 7pm",
    "delete everything",
    "make it a task",
    "make it snappy",
  ])("does not guess: %s", (input) => {
    expect(parseFollowUp(input, today)).toBeNull();
  });
});

describe("parseFollowUp: ambiguous dates and times", () => {
  it("asks which Friday on a Friday", () => {
    expect(parseFollowUp("make that Friday", today)).toEqual({
      kind: "choose_move",
      options: [
        { date: "2026-09-25", time: null },
        { date: "2026-10-02", time: null },
      ],
    });
  });

  it("asks am or pm for a bare hour", () => {
    expect(parseFollowUp("move it to 3", today)).toEqual({
      kind: "choose_move",
      options: [
        { date: null, time: "03:00" },
        { date: null, time: "15:00" },
      ],
    });
  });

  it("offers each date and time combination", () => {
    expect(parseFollowUp("move it to fri at 3", today)).toMatchObject({
      kind: "choose_move",
      options: { length: 4 },
    });
  });
});
