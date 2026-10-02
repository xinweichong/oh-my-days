import { describe, expect, it } from "vitest";
import {
  canTransition,
  isTerminal,
  OPERATION_STATUSES,
  requiresConfirmation,
} from "../../src/domain/operation-status";

describe("operation lifecycle", () => {
  it("cannot leave a terminal state", () => {
    for (const terminal of ["succeeded", "failed", "cancelled"] as const) {
      expect(isTerminal(terminal)).toBe(true);
      for (const to of OPERATION_STATUSES) expect(canTransition(terminal, to)).toBe(false);
    }
  });

  it("only runs confirmed work: awaiting_confirmation cannot jump to applying", () => {
    expect(canTransition("awaiting_confirmation", "applying")).toBe(false);
    expect(canTransition("awaiting_confirmation", "ready")).toBe(true);
    expect(canTransition("ready", "applying")).toBe(true);
  });

  it("returns to confirmation when a revalidated preview changed", () => {
    expect(canTransition("applying", "awaiting_confirmation")).toBe(true);
  });
});

describe("confirmation policy (spec §4)", () => {
  const plain = { deletesOrCancels: false, scope: "single", notifiesAttendees: false } as const;

  it("executes clear single-item creates and edits immediately", () => {
    expect(requiresConfirmation(plain)).toBe(false);
  });

  it.each([
    ["deletion or cancellation", { ...plain, deletesOrCancels: true }],
    ["an entire recurring series", { ...plain, scope: "series" as const }],
    ["attendee notifications", { ...plain, notifiesAttendees: true }],
  ])("requires confirmation for %s", (_label, impact) => {
    expect(requiresConfirmation(impact)).toBe(true);
  });
});
