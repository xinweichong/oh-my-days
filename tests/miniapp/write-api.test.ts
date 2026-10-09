import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { rows } from "../support/db";
import { OTHER_USER } from "../support/fakes";
import { appApi } from "../support/miniapp";
import { ownerCalendar, setUpOwner, World } from "../support/world";

// World time starts at Fri 25 Sep 2026, 09:00 in Singapore. Synthetic data only.
let keys = 0;
const key = () => `test-key-${String(++keys).padStart(4, "0")}`;

async function taskRow(title: string) {
  const [task] = await rows<{
    id: string;
    version: number;
    status: string;
    title: string;
    due_date: string | null;
    snoozed_until: number | null;
    list_id: string;
  }>(
    env.DB,
    "SELECT id, version, status, title, due_date, snoozed_until, list_id FROM tasks WHERE title = ?",
    title,
  );
  if (!task) throw new Error(`no task ${title}`);
  return task;
}

function markers(world: World, title: string) {
  return [...ownerCalendar(world).events.values()].filter(
    (e) => e.status !== "cancelled" && e.fields.summary.includes(title),
  );
}

describe("Mini App task writes (D7 5b)", () => {
  it("completes a task like chat does, and a replayed key changes nothing", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await world.send("Pay rent by tomorrow");
    await world.tick();
    const task = await taskRow("Pay rent");
    const k = key();
    const done = await appApi(world, `tasks/${task.id}/complete`, {
      method: "POST",
      body: { key: k, version: task.version },
    });
    expect(done).toMatchObject({
      status: 200,
      body: { task: { status: "completed", version: task.version + 1 } },
    });
    const replay = await appApi(world, `tasks/${task.id}/complete`, {
      method: "POST",
      body: { key: k, version: task.version },
    });
    expect(replay).toMatchObject({
      status: 200,
      body: { replayed: true, task: { version: task.version + 1 } },
    });
    await world.tick();
    expect(markers(world, "Pay rent").map((e) => e.fields.summary)).toEqual(["✓ [Inbox] Pay rent"]);
    // Undo from the app is a reopen at the new version.
    const reopened = await appApi(world, `tasks/${task.id}/reopen`, {
      method: "POST",
      body: { key: key(), version: task.version + 1 },
    });
    expect(reopened.body).toMatchObject({ task: { status: "open" } });
  });

  it("refuses a stale version with the current task instead of overwriting", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await world.send("Pay rent by tomorrow");
    const task = await taskRow("Pay rent");
    await world.send("rename it to Pay rent (October)"); // changed in chat
    const result = await appApi(world, `tasks/${task.id}/rename`, {
      method: "POST",
      body: { key: key(), version: task.version, title: "Rent" },
    });
    expect(result).toMatchObject({
      status: 409,
      body: { error: "stale", task: { title: "Pay rent (October)", version: task.version + 1 } },
    });
    expect((await taskRow("Pay rent (October)")).title).toBe("Pay rent (October)");
  });

  it("renames, moves, sets and removes deadlines, and snoozes without moving the deadline", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await world.send("/task");
    await world.press("Lists");
    await world.press("New list");
    await world.send("Home");
    await world.send("Pay rent by tomorrow");
    let task = await taskRow("Pay rent");
    const post = (action: string, body: Record<string, unknown>) =>
      appApi(world, `tasks/${task.id}/${action}`, {
        method: "POST",
        body: { key: key(), version: task.version, ...body },
      });

    expect((await post("rename", { title: "Pay the rent" })).status).toBe(200);
    task = await taskRow("Pay the rent");
    const [home] = await rows<{ id: string }>(
      env.DB,
      "SELECT id FROM task_lists WHERE name = 'Home'",
    );
    expect((await post("move", { listId: home?.id })).body).toMatchObject({
      task: { list: { name: "Home" } },
    });
    task = await taskRow("Pay the rent");
    expect(
      (
        await post("deadline", {
          deadline: { kind: "datetime", date: "2026-09-28", time: "15:00" },
        })
      ).body,
    ).toMatchObject({ task: { deadline: { label: "Due Mon 28 Sep, 3pm" } } });
    task = await taskRow("Pay the rent");
    const snoozed = await post("snooze", { preset: "tomorrow" });
    expect(snoozed.body).toMatchObject({ task: { snoozeLabel: "Snoozed until Sat 26 Sep 8am" } });
    task = await taskRow("Pay the rent");
    expect(task.snoozed_until).toBe(Date.UTC(2026, 8, 26, 0));
    expect((await post("deadline", { deadline: { kind: "none" } })).body).toMatchObject({
      task: { deadline: { kind: "none" } },
    });
    await world.tick();
    expect(markers(world, "Pay the rent")).toHaveLength(0);
    task = await taskRow("Pay the rent");
    expect((await post("move", { listId: "not-a-list" })).status).toBe(400);
    expect((await post("snooze", { date: "2026-09-01", time: "09:00" })).status).toBe(400);
  });

  it("cancels only with a confirmation bound to the version it previewed", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await world.send("Pay rent by tomorrow");
    const task = await taskRow("Pay rent");
    const preview = await appApi(world, `tasks/${task.id}/cancel-preview`, {
      method: "POST",
      body: { version: task.version },
    });
    expect(preview.body).toMatchObject({
      text: "Cancel task: Pay rent? Its deadline is removed from Google Calendar.",
      confirmLabel: "Cancel task",
    });
    const wrong = await appApi(world, `tasks/${task.id}/cancel`, {
      method: "POST",
      body: { key: key(), version: task.version, previewHash: "0".repeat(64) },
    });
    expect(wrong.status).toBe(409);
    expect((await taskRow("Pay rent")).status).toBe("open");
    const confirmed = await appApi(world, `tasks/${task.id}/cancel`, {
      method: "POST",
      body: { key: key(), version: task.version, previewHash: preview.body.previewHash },
    });
    expect(confirmed.body).toMatchObject({ task: { status: "cancelled" } });
  });

  it("never lets one user change another user's task", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await world.send("Pay rent by tomorrow");
    await world.send("/start", OTHER_USER);
    await env.DB.prepare("UPDATE users SET setup_step = 'done' WHERE telegram_user_id = ?")
      .bind(OTHER_USER)
      .run();
    const task = await taskRow("Pay rent");
    const result = await appApi(world, `tasks/${task.id}/complete`, {
      method: "POST",
      as: OTHER_USER,
      body: { key: key(), version: task.version },
    });
    expect(result.status).toBe(404);
    expect((await taskRow("Pay rent")).status).toBe("open");
  });

  it("lets only one of two concurrent changes at the same version win", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await world.send("Pay rent by tomorrow");
    const task = await taskRow("Pay rent");
    const [a, b] = await Promise.all([
      appApi(world, `tasks/${task.id}/rename`, {
        method: "POST",
        body: { key: key(), version: task.version, title: "A" },
      }),
      appApi(world, `tasks/${task.id}/rename`, {
        method: "POST",
        body: { key: key(), version: task.version, title: "B" },
      }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const [row] = await rows<{ version: number }>(
      env.DB,
      "SELECT version FROM tasks WHERE id = ?",
      task.id,
    );
    expect(row?.version).toBe(task.version + 1);
  });
});

describe("Mini App quick add (D7 5b, A1 rules)", () => {
  it("adds a task, once per key", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    const k = key();
    const added = await appApi(world, "tasks", {
      method: "POST",
      body: { key: k, text: "Pay rent by tomorrow" },
    });
    expect(added.body).toMatchObject({
      kind: "task",
      task: { title: "Pay rent", deadline: { label: "Due Sat 26 Sep" } },
    });
    const again = await appApi(world, "tasks", {
      method: "POST",
      body: { key: k, text: "Pay rent by tomorrow" },
    });
    expect(again.body).toMatchObject({ replayed: true, task: { title: "Pay rent" } });
    expect(await rows(env.DB, "SELECT id FROM tasks")).toHaveLength(1);
  });

  it("adds an event through the same operation, with the result in chat", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    const added = await appApi(world, "tasks", {
      method: "POST",
      body: { key: key(), text: "Dinner Sat 7pm" },
    });
    expect(added.body).toMatchObject({ kind: "event", title: "Dinner", when: "Sat 26 Sep, 7pm" });
    await world.tick();
    expect(world.lastText()).toBe(
      "Event added: Dinner\nSat 26 Sep 2026, 7–8pm · owner@example.com",
    );
  });

  it("asks instead of guessing, and accepts the chosen reading", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    const asked = await appApi(world, "tasks", {
      method: "POST",
      body: { key: key(), text: "Dentist Mon" },
    });
    expect(asked.body).toMatchObject({
      kind: "choose",
      message: "A task due that day, or an all-day event?",
      options: [{ label: "Task due Mon 28 Sep" }, { label: "All-day event Mon 28 Sep" }],
    });
    const options = asked.body.options as { draft: unknown }[];
    const chosen = await appApi(world, "tasks", {
      method: "POST",
      body: { key: key(), draft: options[0]?.draft },
    });
    expect(chosen.body).toMatchObject({ kind: "task", task: { title: "Dentist" } });
    const multiple = await appApi(world, "tasks", {
      method: "POST",
      body: { key: key(), text: "Gym 7am; dinner 8pm" },
    });
    expect(multiple.body).toMatchObject({ kind: "multiple" });
  });

  it("refuses a draft naming a list that isn't the user's", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    const result = await appApi(world, "tasks", {
      method: "POST",
      body: {
        key: key(),
        draft: { kind: "task", title: "X", due: { kind: "none" }, listId: "someone-elses" },
      },
    });
    expect(result.status).toBe(400);
  });
});

describe("Mini App series actions", () => {
  it("renames and stops a series only after a bound preview", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await world.send("/task");
    await world.press("New task");
    await world.send("Water plants");
    await world.press("Today · Fri 25 Sep");
    await world.press("Any time that day");
    await world.press("Weekly");
    await world.tick();
    const [series] = await rows<{ id: string; version: number }>(
      env.DB,
      "SELECT id, version FROM task_series",
    );
    const preview = await appApi(world, `series/${series?.id}/rename-preview`, {
      method: "POST",
      body: { version: series?.version, title: "Water the plants" },
    });
    expect(preview.body).toMatchObject({ confirmLabel: "Rename series" });
    const renamed = await appApi(world, `series/${series?.id}/rename`, {
      method: "POST",
      body: {
        key: key(),
        version: series?.version,
        title: "Water the plants",
        previewHash: preview.body.previewHash,
      },
    });
    expect(renamed.status).toBe(200);
    const titles = await rows<{ title: string }>(
      env.DB,
      "SELECT DISTINCT title FROM tasks WHERE status = 'open'",
    );
    expect(titles.map((t) => t.title)).toEqual(["Water the plants"]);
    // A preview made for the old version no longer confirms anything.
    const stale = await appApi(world, `series/${series?.id}/stop`, {
      method: "POST",
      body: { key: key(), version: series?.version, previewHash: preview.body.previewHash },
    });
    expect(stale.status).toBe(409);
  });
});

describe("Mini App bulk actions (D7 5c)", () => {
  async function three(world: World) {
    await world.send("Pay rent by today");
    await world.send("Call bank by today");
    await world.send("Buy milk");
    return rows<{ id: string; version: number; title: string }>(
      env.DB,
      "SELECT id, version, title FROM tasks ORDER BY title",
    );
  }

  it("completes several, each only at the version shown, with one summary", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    const tasks = await three(world);
    await world.send("/tasks");
    await world.press(/Buy milk/);
    await world.press("Done"); // changed in chat after the app showed it
    const k = key();
    const result = await appApi(world, "tasks/bulk", {
      method: "POST",
      body: {
        key: k,
        action: "complete",
        items: tasks.map((t) => ({ id: t.id, version: t.version })),
      },
    });
    expect(result.body).toMatchObject({
      summary: "Completed 2 tasks. 1 changed elsewhere and was left as it was.",
      applied: 2,
    });
    const replay = await appApi(world, "tasks/bulk", {
      method: "POST",
      body: {
        key: k,
        action: "complete",
        items: tasks.map((t) => ({ id: t.id, version: t.version })),
      },
    });
    expect(replay.body).toMatchObject({ replayed: true, summary: result.body.summary });
    const statuses = await rows<{ status: string }>(env.DB, "SELECT DISTINCT status FROM tasks");
    expect(statuses.map((s) => s.status)).toEqual(["completed"]);
  });

  it("snoozes and moves several without touching deadlines", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    const tasks = await three(world);
    const items = tasks.map((t) => ({ id: t.id, version: t.version }));
    const snoozed = await appApi(world, "tasks/bulk", {
      method: "POST",
      body: { key: key(), action: "snooze", preset: "tomorrow", items },
    });
    expect(snoozed.body).toMatchObject({ summary: "Snoozed 3 tasks. Deadlines unchanged." });
    const dates = await rows<{ due_date: string | null }>(
      env.DB,
      "SELECT due_date FROM tasks ORDER BY title",
    );
    expect(dates.map((d) => d.due_date)).toEqual([null, "2026-09-25", "2026-09-25"]);
    expect(
      (
        await appApi(world, "tasks/bulk", {
          method: "POST",
          body: { key: key(), action: "move", listId: "nope", items },
        })
      ).status,
    ).toBe(400);
  });

  it("cancels several only with a confirmation bound to exactly that set", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    const tasks = await three(world);
    const items = tasks.map((t) => ({ id: t.id, version: t.version }));
    const preview = await appApi(world, "tasks/bulk-cancel-preview", {
      method: "POST",
      body: { items },
    });
    expect(preview.body).toMatchObject({
      text: "Cancel 3 tasks? Deadlines are removed from Google Calendar for 2 tasks.",
      confirmLabel: "Cancel 3 tasks",
    });
    const fewer = await appApi(world, "tasks/bulk-cancel", {
      method: "POST",
      body: { key: key(), items: items.slice(1), previewHash: preview.body.previewHash },
    });
    expect(fewer.status).toBe(409);
    const done = await appApi(world, "tasks/bulk-cancel", {
      method: "POST",
      body: { key: key(), items, previewHash: preview.body.previewHash },
    });
    expect(done.body).toMatchObject({ summary: "Cancelled 3 tasks." });
  });

  it("never touches another user's tasks", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    const tasks = await three(world);
    await world.send("/start", OTHER_USER);
    await env.DB.prepare("UPDATE users SET setup_step = 'done' WHERE telegram_user_id = ?")
      .bind(OTHER_USER)
      .run();
    const result = await appApi(world, "tasks/bulk", {
      method: "POST",
      as: OTHER_USER,
      body: {
        key: key(),
        action: "complete",
        items: tasks.map((t) => ({ id: t.id, version: t.version })),
      },
    });
    expect(result.body).toMatchObject({ applied: 0 });
    const statuses = await rows<{ status: string }>(env.DB, "SELECT DISTINCT status FROM tasks");
    expect(statuses.map((s) => s.status)).toEqual(["open"]);
  });
});
