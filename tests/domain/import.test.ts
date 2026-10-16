import { describe, expect, it } from "vitest";
import { MAX_IMPORT, readImport } from "../../src/domain/import";

// Synthetic lists and dates only. Fri 16 Oct 2026.
const lists = [
  { id: "inbox", name: "Inbox" },
  { id: "cs", name: "CS4263" },
  { id: "ma", name: "MA1521" },
];
const ctx = { today: "2026-10-16", lists, inboxId: "inbox" };

describe("readImport (bulk task import)", () => {
  it("reads each line with the quick-capture grammar into a task", () => {
    const result = readImport(
      [
        "DQ8 by Sun 18 Oct 11:59pm to CS4263",
        "Quiz 3 by Mon 26 Oct 9am in ma1521",
        "Buy milk",
        "Reading by Tue 20 Oct",
      ].join("\n"),
      ctx,
      [],
    );
    expect(result.kind).toBe("preview");
    if (result.kind !== "preview") return;
    expect(result.tasks).toEqual([
      {
        line: "DQ8 by Sun 18 Oct 11:59pm to CS4263",
        title: "DQ8",
        listId: "cs",
        due: { kind: "datetime", date: "2026-10-18", time: "23:59" },
        unknownList: null,
      },
      {
        line: "Quiz 3 by Mon 26 Oct 9am in ma1521",
        title: "Quiz 3",
        listId: "ma",
        due: { kind: "datetime", date: "2026-10-26", time: "09:00" },
        unknownList: null,
      },
      {
        line: "Buy milk",
        title: "Buy milk",
        listId: null,
        due: { kind: "none" },
        unknownList: null,
      },
      {
        line: "Reading by Tue 20 Oct",
        title: "Reading",
        listId: null,
        due: { kind: "date", date: "2026-10-20" },
        unknownList: null,
      },
    ]);
    expect(result.skipped).toEqual([]);
  });

  it("ignores blank lines and list bullets, so a copied list pastes as is", () => {
    const result = readImport(
      "\n- Essay by 23 Oct\n• Lab by 24 Oct\n  2. Quiz by 25 Oct\n\n",
      ctx,
      [],
    );
    expect(result.kind === "preview" && result.tasks.map((t) => t.title)).toEqual([
      "Essay",
      "Lab",
      "Quiz",
    ]);
  });

  it("skips what isn't one task, saying why, and imports the rest", () => {
    const result = readImport(
      [
        "Essay by 23 Oct",
        "Lunch with Sam Mon 1pm",
        "Pack by Fri",
        "Call Alex Mon 3pm, Tue 4pm",
        "by Mon 9am",
        "Essay by 23 Oct",
      ].join("\n"),
      ctx,
      [],
    );
    expect(result.kind).toBe("preview");
    if (result.kind !== "preview") return;
    expect(result.tasks.map((t) => t.title)).toEqual(["Essay"]);
    expect(result.skipped).toEqual([
      { line: "Lunch with Sam Mon 1pm", reason: "event" },
      // Today is a Friday: this one or next week's.
      { line: "Pack by Fri", reason: "ambiguous" },
      { line: "Call Alex Mon 3pm, Tue 4pm", reason: "multiple" },
      { line: "by Mon 9am", reason: "no_title" },
      { line: "Essay by 23 Oct", reason: "repeated" },
    ]);
  });

  it("skips a task that already exists, open, in the same list with the same deadline", () => {
    const existing = [
      {
        title: "dq8",
        listId: "cs",
        due: { kind: "datetime" as const, date: "2026-10-18", time: "23:59" },
      },
    ];
    const result = readImport(
      ["DQ8 by Sun 18 Oct 11:59pm to CS4263", "DQ8 by Mon 19 Oct 11:59pm to CS4263"].join("\n"),
      ctx,
      existing,
    );
    expect(result.kind === "preview" && result.skipped).toEqual([
      { line: "DQ8 by Sun 18 Oct 11:59pm to CS4263", reason: "exists" },
    ]);
    expect(result.kind === "preview" && result.tasks.map((t) => t.due)).toEqual([
      { kind: "datetime", date: "2026-10-19", time: "23:59" },
    ]);
  });

  it("flags a 'to' list that doesn't exist: the words stay in the title, as in quick capture", () => {
    const result = readImport("Lab 2 by Mon 26 Oct 6pm to CS5224", ctx, []);
    expect(result.kind === "preview" && result.tasks).toEqual([
      {
        line: "Lab 2 by Mon 26 Oct 6pm to CS5224",
        title: "Lab 2 to CS5224",
        listId: null,
        due: { kind: "datetime", date: "2026-10-26", time: "18:00" },
        unknownList: "CS5224",
      },
    ]);
  });

  it("refuses more tasks than one import can create, before anything else", () => {
    const lines = Array.from({ length: MAX_IMPORT + 1 }, (_, i) => `Task ${i + 1} by 30 Oct`);
    expect(readImport(lines.join("\n"), ctx, [])).toEqual({
      kind: "too_many",
      count: MAX_IMPORT + 1,
    });
    expect(readImport(lines.slice(0, MAX_IMPORT).join("\n"), ctx, []).kind).toBe("preview");
  });

  it("has nothing to import when every line is skipped or the text is empty", () => {
    expect(readImport("  \n \n", ctx, [])).toEqual({ kind: "empty" });
    const result = readImport("Lunch Mon 1pm", ctx, []);
    expect(result).toMatchObject({ kind: "preview", tasks: [] });
  });
});
