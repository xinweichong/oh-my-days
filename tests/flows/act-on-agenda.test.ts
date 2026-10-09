import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { rows } from "../support/db";
import { OTHER_USER } from "../support/fakes";
import { setUpOwner, World } from "../support/world";

// World time starts at Fri 25 Sep 2026, 09:00 in Singapore.
const sgt = (day: number, hour: number, minute = 0) => Date.UTC(2026, 8, day, hour - 8, minute);

async function until(world: World, instant: number) {
  world.clock.current = instant;
  await world.tick();
}

async function tasks() {
  return rows<{
    title: string;
    status: string;
    due_date: string | null;
    snoozed_until: number | null;
  }>(env.DB, "SELECT title, status, due_date, snoozed_until FROM tasks ORDER BY title");
}

/** Two tasks overdue on Saturday, one due Saturday. */
async function seedTasks(world: World) {
  await world.send("Pay rent by today");
  await world.send("Call bank by today");
  await world.send("Submit expenses by tomorrow");
}

describe("acting on tasks from the agenda and /daily (C1)", () => {
  it("lets the user pick a task from the agenda, then act on it", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await seedTasks(world);
    await until(world, sgt(26, 8));
    expect(world.lastText()).toMatch(/^Here's your day\./);
    await world.press("Act on a task");
    expect(world.lastText()).toBe("Which task?");
    expect(world.findButton("Overdue: [Inbox] Call bank · Fri 25 Sep")).toBeTruthy();
    expect(world.findButton("[Inbox] Submit expenses · Sat 26 Sep")).toBeTruthy();
    await world.press("Overdue: [Inbox] Pay rent · Fri 25 Sep");
    expect(world.findButton("Snooze")).toBeTruthy();
    expect(world.findButton("Edit")).toBeTruthy();
    await world.press("Done");
    expect(world.lastText()).toBe("Completed: Pay rent.");
  });

  it("offers the same from /daily, and nothing to act on when the day is clear", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await world.send("/daily");
    expect(() => world.findButton("Act on a task")).toThrow();
    await world.send("Pay rent by today");
    await world.send("/daily");
    await world.press("Act on a task");
    expect(world.findButton("[Inbox] Pay rent · Fri 25 Sep")).toBeTruthy();
  });
});

describe("snoozing all overdue tasks (C1)", () => {
  it("asks once with the count, snoozes each, never moves deadlines, and undoes once", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await seedTasks(world);
    await until(world, sgt(26, 8));
    await world.press("Snooze all overdue → tomorrow 8am");
    expect(world.lastText()).toBe(
      "Snooze 2 overdue tasks until Sun 27 Sep 8am?\nDeadlines stay as they are.",
    );
    expect((await tasks()).every((t) => t.snoozed_until === null)).toBe(true);
    await world.press("Snooze 2");
    expect(world.lastText()).toBe(
      "Snoozed 2 overdue tasks until Sun 27 Sep 8am. Deadlines unchanged.",
    );
    expect(await tasks()).toEqual([
      { title: "Call bank", status: "open", due_date: "2026-09-25", snoozed_until: sgt(27, 8) },
      { title: "Pay rent", status: "open", due_date: "2026-09-25", snoozed_until: sgt(27, 8) },
      { title: "Submit expenses", status: "open", due_date: "2026-09-26", snoozed_until: null },
    ]);
    await world.send("/daily");
    expect(world.lastText()).not.toContain("overdue");

    await world.press("Undo");
    expect((await tasks()).every((t) => t.snoozed_until === null)).toBe(true);
  });

  it("is bound to the confirmed set: a task changed since is left alone", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await seedTasks(world);
    await until(world, sgt(26, 8));
    await world.press("Snooze all overdue → tomorrow 8am");
    await world.send("/tasks");
    await world.press(/Call bank/);
    await world.press("Done");
    await world.press("Snooze 2");
    expect(world.lastText()).toBe(
      "Snoozed 1 overdue task until Sun 27 Sep 8am. Deadlines unchanged.\n1 changed since and was left as it was.",
    );
    const byTitle = Object.fromEntries((await tasks()).map((t) => [t.title, t]));
    expect(byTitle["Call bank"]?.snoozed_until).toBeNull();
    expect(byTitle["Pay rent"]?.snoozed_until).toBe(sgt(27, 8));
  });

  it("Undo leaves a task alone if it changed after the snooze", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await seedTasks(world);
    await until(world, sgt(26, 8));
    await world.press("Snooze all overdue → tomorrow 8am");
    await world.press("Snooze 2");
    await world.send("/tasks");
    await world.press(/Pay rent/);
    await world.press("Snooze");
    await world.press("In 1 hour");
    await world.press("Undo");
    const byTitle = Object.fromEntries((await tasks()).map((t) => [t.title, t]));
    expect(byTitle["Call bank"]?.snoozed_until).toBeNull();
    expect(byTitle["Pay rent"]?.snoozed_until).toBe(sgt(26, 9));
  });

  it("refuses another user's buttons", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await seedTasks(world);
    await until(world, sgt(26, 8));
    await world.press("Snooze all overdue → tomorrow 8am");
    await world.press("Snooze 2", OTHER_USER);
    expect(world.answers().at(-1)).toBe("This button is no longer valid.");
    expect((await tasks()).every((t) => t.snoozed_until === null)).toBe(true);
  });
});
