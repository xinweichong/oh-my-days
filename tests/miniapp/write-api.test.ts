import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { MAX_BULK_WRITE, MAX_SELECTION } from "../../src/miniapp/writes";
import { countingDb } from "../support/counting-db";
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
    const [chunk] = preview.body.chunks as { items: unknown[]; previewHash: string }[];
    expect(chunk?.items).toHaveLength(3);
    const fewer = await appApi(world, "tasks/bulk-cancel", {
      method: "POST",
      body: { key: key(), items: items.slice(1), previewHash: chunk?.previewHash },
    });
    expect(fewer.status).toBe(409);
    const done = await appApi(world, "tasks/bulk-cancel", {
      method: "POST",
      body: { key: key(), items, previewHash: chunk?.previewHash },
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

describe("Mini App bulk actions within the D1 query limit", () => {
  /** Tasks with deadlines, created through /import (8 per import). */
  async function many(world: World, n: number) {
    for (let start = 0; start < n; start += 8) {
      const lines = Array.from(
        { length: Math.min(8, n - start) },
        (_, i) => `Task ${String(start + i + 1).padStart(3, "0")} by 30 Oct 5pm`,
      );
      await world.send(["/import", ...lines].join("\n"));
      await world.press(/^Import \d+ tasks?$/);
    }
    return rows<{ id: string; version: number }>(
      env.DB,
      "SELECT id, version FROM tasks ORDER BY title",
    );
  }

  it(`changes up to ${MAX_BULK_WRITE} tasks per request within Workers Free's 50 queries`, async () => {
    const counter = countingDb(env.DB);
    const world = new World(counter.db);
    await setUpOwner(world);
    await world.send("/task");
    await world.press("Lists");
    await world.press("New list");
    await world.send("Work");
    const [work] = await rows<{ id: string }>(
      env.DB,
      "SELECT id FROM task_lists WHERE name = 'Work'",
    );
    await many(world, MAX_BULK_WRITE);
    const current = async () =>
      (await rows<{ id: string; version: number }>(env.DB, "SELECT id, version FROM tasks")).map(
        (t) => ({ id: t.id, version: t.version }),
      );
    const cost = async (path: string, body: Record<string, unknown>) => {
      const before = counter.queries.length;
      const result = await appApi(world, path, { method: "POST", body });
      return { queries: counter.queries.length - before, result };
    };
    // Each step changes all twenty: the costliest case for each action.
    const snooze = await cost("tasks/bulk", {
      key: key(),
      action: "snooze",
      preset: "hour",
      items: await current(),
    });
    const move = await cost("tasks/bulk", {
      key: key(),
      action: "move",
      listId: work?.id,
      items: await current(),
    });
    const preview = await cost("tasks/bulk-cancel-preview", { items: await current() });
    const [chunk] = preview.result.body.chunks as { items: unknown[]; previewHash: string }[];
    const cancel = await cost("tasks/bulk-cancel", {
      key: key(),
      items: chunk?.items,
      previewHash: chunk?.previewHash,
    });
    await env.DB.prepare("UPDATE tasks SET status = 'open', cancelled_at = NULL").run();
    const complete = await cost("tasks/bulk", {
      key: key(),
      action: "complete",
      items: await current(),
    });
    for (const [name, step] of Object.entries({ snooze, move, preview, cancel, complete })) {
      expect([name, step.result.status]).toEqual([name, 200]);
      expect([name, step.queries <= 50]).toEqual([name, true]);
    }
    expect(complete.result.body).toMatchObject({ applied: MAX_BULK_WRITE });
  });

  it(`refuses more than ${MAX_BULK_WRITE} tasks in one change, so the app sends them in parts`, async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    const items = Array.from({ length: MAX_BULK_WRITE + 1 }, (_, i) => ({
      id: `t${i}`,
      version: 1,
    }));
    for (const path of ["tasks/bulk", "tasks/bulk-cancel"]) {
      const result = await appApi(world, path, {
        method: "POST",
        body: { key: key(), action: "complete", previewHash: "x", items },
      });
      expect(result.status).toBe(400);
    }
    const selection = Array.from({ length: MAX_SELECTION + 1 }, (_, i) => ({
      id: `t${i}`,
      version: 1,
    }));
    const tooMany = await appApi(world, "tasks/bulk-cancel-preview", {
      method: "POST",
      body: { items: selection },
    });
    expect(tooMany.status).toBe(400);
  });

  it("previews cancelling a large selection once, confirmed group by group for exactly those tasks", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    const tasks = await many(world, MAX_BULK_WRITE + 4);
    const items = tasks.map((t) => ({ id: t.id, version: t.version }));
    const preview = await appApi(world, "tasks/bulk-cancel-preview", {
      method: "POST",
      body: { items },
    });
    expect(preview.body).toMatchObject({ confirmLabel: `Cancel ${MAX_BULK_WRITE + 4} tasks` });
    const chunks = preview.body.chunks as { items: { id: string }[]; previewHash: string }[];
    expect(chunks.map((c) => c.items.length)).toEqual([MAX_BULK_WRITE, 4]);
    // Together the groups are exactly the selection, each task once.
    expect(chunks.flatMap((c) => c.items.map((i) => i.id)).sort()).toEqual(
      items.map((i) => i.id).sort(),
    );
    // A group's confirmation doesn't carry over to another group.
    const swapped = await appApi(world, "tasks/bulk-cancel", {
      method: "POST",
      body: { key: key(), items: chunks[1]?.items, previewHash: chunks[0]?.previewHash },
    });
    expect(swapped.status).toBe(409);
    for (const chunk of chunks) {
      const done = await appApi(world, "tasks/bulk-cancel", {
        method: "POST",
        body: { key: key(), items: chunk.items, previewHash: chunk.previewHash },
      });
      expect(done.status).toBe(200);
    }
    const open = await rows(env.DB, "SELECT id FROM tasks WHERE status = 'open'");
    expect(open).toEqual([]);
  });
});

describe("Mini App reconnect", () => {
  it("issues a fresh reconnect link only while the connection needs it, for that user", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    expect(await appApi(world, "reconnect-link", { method: "POST", body: {} })).toEqual({
      status: 409,
      body: { error: "not_needed" },
    });
    await env.DB.prepare("UPDATE google_connections SET status = 'auth_required'").run();
    const result = await appApi(world, "reconnect-link", { method: "POST", body: {} });
    expect(result.status).toBe(200);
    const url = new URL(String(result.body.url));
    expect(url.pathname).toBe("/connect");
    const links = await rows<{ user_id: string; purpose: string }>(
      env.DB,
      "SELECT l.user_id, l.purpose FROM connect_links l WHERE token = ?",
      url.searchParams.get("t"),
    );
    const [owner] = await rows<{ id: string }>(
      env.DB,
      "SELECT user_id AS id FROM google_connections",
    );
    expect(links).toEqual([{ user_id: owner?.id, purpose: "reconnect" }]);
  });
});
