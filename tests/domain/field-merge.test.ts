import { describe, expect, it } from "vitest";
import { canonicalJson, mergeIntended, planUndo, valuesEqual } from "../../src/domain/field-merge";

const four = { dateTime: "2026-09-25T16:00:00+08:00", timeZone: "Asia/Singapore" };
const three = { dateTime: "2026-09-25T15:00:00+08:00", timeZone: "Asia/Singapore" };
const five = { dateTime: "2026-09-25T17:00:00+08:00", timeZone: "Asia/Singapore" };

describe("mergeIntended", () => {
  it("writes fields that are unchanged since the base", () => {
    expect(
      mergeIntended({ start: three }, { start: three, summary: "Call" }, { start: four }),
    ).toEqual({
      patch: { start: four },
      conflicts: [],
    });
  });

  it("preserves unrelated external edits by writing only intended fields", () => {
    const result = mergeIntended(
      { start: three },
      { start: three, summary: "Renamed in Calendar" },
      { start: four },
    );
    expect(result.patch).toEqual({ start: four });
    expect(result.patch).not.toHaveProperty("summary");
  });

  it("reports a same-field external edit as a conflict instead of overwriting it", () => {
    // Spec §8: moved to 5pm in Calendar while the request to move to 4pm was pending.
    expect(mergeIntended({ start: three }, { start: five }, { start: four })).toEqual({
      patch: {},
      conflicts: ["start"],
    });
  });

  it("treats a field already at the intended value as applied", () => {
    expect(mergeIntended({ start: three }, { start: four }, { start: four })).toEqual({
      patch: {},
      conflicts: [],
    });
  });
});

describe("planUndo", () => {
  it("restores prior values when nothing changed since", () => {
    expect(planUndo({ before: { start: three }, after: { start: four } }, { start: four })).toEqual(
      {
        eligible: true,
        patch: { start: three },
      },
    );
  });

  it("refuses to overwrite a subsequent edit", () => {
    expect(planUndo({ before: { start: three }, after: { start: four } }, { start: five })).toEqual(
      {
        eligible: false,
        changedFields: ["start"],
      },
    );
  });
});

describe("canonicalJson", () => {
  it("is independent of key order", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [1, { f: 1, e: 2 }] } })).toBe(
      '{"a":{"c":[1,{"e":2,"f":1}],"d":2},"b":1}',
    );
    expect(valuesEqual({ a: 1, b: undefined }, { a: 1 })).toBe(true);
  });
});
