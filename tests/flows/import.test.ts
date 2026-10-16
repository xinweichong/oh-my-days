import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { MAX_IMPORT } from "../../src/domain/import";
import { countingDb } from "../support/counting-db";
import { rows } from "../support/db";
import { OTHER_USER } from "../support/fakes";
import { setUpOwner, World } from "../support/world";

// World time starts at Fri 25 Sep 2026, 09:00 in Singapore. Synthetic data only.

async function newList(world: World, name: string): Promise<void> {
  await world.send("/task");
  await world.press("Lists");
  await world.press("New list");
  await world.send(name);
}

async function tasks() {
  return rows<{
    title: string;
    list: string;
    status: string;
    due_kind: string;
    due_date: string | null;
  }>(
    env.DB,
    `SELECT t.title, l.name AS list, t.status, t.due_kind, t.due_date
     FROM tasks t JOIN task_lists l ON l.id = t.list_id ORDER BY t.title`,
  );
}

describe("/import", () => {
  it("previews every line, then adds them all with one confirmation", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await newList(world, "CS4263");
    await world.send(
      [
        "/import",
        "DQ8 by Sun 27 Sep 11:59pm to CS4263",
        "- Project report by Mon 9 Nov 11:59pm to cs4263",
        "Buy milk",
      ].join("\n"),
    );
    expect(world.lastText()).toBe(
      [
        "Import 3 tasks?",
        "• DQ8 · Due Sun 27 Sep, 11:59pm · CS4263",
        "• Project report · Due Mon 9 Nov, 11:59pm · CS4263",
        "• Buy milk · No deadline · Inbox",
      ].join("\n"),
    );
    // Nothing exists until the import is confirmed.
    expect(await tasks()).toEqual([]);

    await world.press("Import 3 tasks");
    expect(world.lastText()).toBe("Imported 3 tasks: 2 to CS4263, 1 to Inbox.");
    expect(await tasks()).toEqual([
      { title: "Buy milk", list: "Inbox", status: "open", due_kind: "none", due_date: null },
      { title: "DQ8", list: "CS4263", status: "open", due_kind: "datetime", due_date: null },
      {
        title: "Project report",
        list: "CS4263",
        status: "open",
        due_kind: "datetime",
        due_date: null,
      },
    ]);
    // The deadlines reach the task calendar like any other task's.
    await world.tick();
    const failed = await rows(env.DB, "SELECT id FROM operations WHERE status != 'succeeded'");
    expect(failed).toEqual([]);
  });

  it("says what it skips and why, flags an unknown list, and Cancel adds nothing", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await world.send(
      [
        "/import",
        "Essay by 30 Sep",
        "Lunch with Sam Mon 1pm",
        "Pack by Fri",
        "Lab 2 by 1 Oct 6pm to CS5224",
        "Essay by 30 Sep",
      ].join("\n"),
    );
    expect(world.lastText()).toBe(
      [
        "Import 2 tasks?",
        "• Essay · Due Wed 30 Sep · Inbox",
        "• Lab 2 to CS5224 · Due Thu 1 Oct, 6pm · Inbox (no list named CS5224, so it stays in the title)",
        "",
        "Not imported (3):",
        '• Lunch with Sam Mon 1pm: a time without "by" reads as an event; put "by" before the date for a deadline.',
        "• Pack by Fri: the date or time could mean two things; write the date, like 23 Oct.",
        "• Essay by 30 Sep: same as an earlier line.",
      ].join("\n"),
    );
    await world.press("Cancel");
    expect(world.lastText()).toBe("Nothing was imported.");
    expect(await tasks()).toEqual([]);
  });

  it(`refuses more than ${MAX_IMPORT} tasks at once, adding none`, async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    const lines = Array.from({ length: MAX_IMPORT + 2 }, (_, i) => `Task ${i + 1} by 30 Oct`);
    await world.send(["/import", ...lines].join("\n"));
    expect(world.lastText()).toBe(
      `That's ${MAX_IMPORT + 2} tasks; one import adds up to ${MAX_IMPORT}. Send the first ${MAX_IMPORT} with /import, then the rest in another. Nothing was added.`,
    );
    expect(await tasks()).toEqual([]);
  });

  it("asks for the list when /import comes alone", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await world.send("/import");
    expect(world.lastText()).toMatch(new RegExp(`^Send up to ${MAX_IMPORT} tasks, one per line`));
    await world.send("Essay by 30 Sep\nQuiz by 2 Oct 9am");
    expect(world.lastText()).toMatch(/^Import 2 tasks\?/);
    await world.press("Import 2 tasks");
    expect((await tasks()).map((t) => t.title)).toEqual(["Essay", "Quiz"]);
  });

  it("skips tasks that already exist, so importing the same list twice adds nothing new", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await world.send("/import\nEssay by 30 Sep\nQuiz by 2 Oct 9am");
    await world.press("Import 2 tasks");
    await world.send("/import\nEssay by 30 Sep\nQuiz by 2 Oct 9am\nLab by 3 Oct");
    expect(world.lastText()).toMatch(/^Import 1 task\?\n• Lab · Due Sat 3 Oct · Inbox/);
    expect(world.lastText()).toContain("• Essay by 30 Sep: already in your tasks.");
    await world.press("Import 1 task");
    expect((await tasks()).map((t) => t.title)).toEqual(["Essay", "Lab", "Quiz"]);
  });

  it("adds nothing if a list was deleted between the preview and the confirmation", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await newList(world, "Work");
    await world.send("/import\nExpenses by 30 Sep to Work");
    await world.send("/task");
    await world.press("Lists");
    await world.press("Work (0 open)");
    await world.press("Delete list Work");
    await world.press(/^Delete/);
    await world.press("Import 1 task");
    expect(world.lastText()).toBe(
      "A list in this import has changed since the preview, so nothing was added. Send /import again.",
    );
    expect(await tasks()).toEqual([]);
  });

  it("acts once on Import, and never on another user's press", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await world.send("/import\nEssay by 30 Sep");
    await world.press("Import 1 task", OTHER_USER);
    expect(await tasks()).toEqual([]);
    await world.press("Import 1 task");
    await world.press("Import 1 task");
    expect((await tasks()).map((t) => t.title)).toEqual(["Essay"]);
  });

  it("undoes an import after asking, keeping tasks changed since", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await world.send("/import\nEssay by 30 Sep\nQuiz by 2 Oct 9am\nLab by 3 Oct");
    await world.press("Import 3 tasks");
    await env.DB.prepare(
      "UPDATE tasks SET title = 'Quiz 3', version = version + 1 WHERE title = 'Quiz'",
    ).run();
    await world.press("Undo import");
    expect(world.lastText()).toBe(
      "Remove the 3 tasks from this import? Any you've changed since stay.",
    );
    expect((await tasks()).every((t) => t.status === "open")).toBe(true);
    await world.press("Remove 3 tasks");
    expect(world.lastText()).toBe("Removed 2 tasks from the import. 1 changed since, so it stays.");
    expect((await tasks()).map((t) => [t.title, t.status])).toEqual([
      ["Essay", "cancelled"],
      ["Lab", "cancelled"],
      ["Quiz 3", "open"],
    ]);
  });

  it(`stays within Workers Free's 50 D1 queries when adding or removing ${MAX_IMPORT} tasks`, async () => {
    const counter = countingDb(env.DB);
    const world = new World(counter.db);
    await setUpOwner(world);
    // The costliest case: deadlines inside the reminder window add a statement each.
    const lines = Array.from({ length: MAX_IMPORT }, (_, i) => `Task ${i + 1} by 25 Sep 9:30am`);
    await world.send(["/import", ...lines].join("\n"));
    // One press is one webhook invocation; scheduled work is not run here.
    let before = counter.queries.length;
    await world.press(`Import ${MAX_IMPORT} tasks`);
    expect(counter.queries.length - before).toBeLessThanOrEqual(50);
    await world.press("Undo import");
    before = counter.queries.length;
    await world.press(`Remove ${MAX_IMPORT} tasks`);
    expect(counter.queries.length - before).toBeLessThanOrEqual(50);
    expect((await tasks()).filter((t) => t.status === "cancelled")).toHaveLength(MAX_IMPORT);
  });
});
