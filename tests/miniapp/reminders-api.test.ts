import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { rows } from "../support/db";
import { OTHER_USER } from "../support/fakes";
import { appApi } from "../support/miniapp";
import { ownerCalendar, PRIMARY, setUpOwner, World } from "../support/world";

// Mini App reminders (ADR 0008). World time starts at Fri 25 Sep 2026, 09:00 in
// Singapore. Synthetic data only.
let keys = 0;
const key = () => `reminder-key-${String(++keys).padStart(4, "0")}`;

async function taskId(title: string): Promise<string> {
  const [task] = await rows<{ id: string }>(env.DB, "SELECT id FROM tasks WHERE title = ?", title);
  if (!task) throw new Error(`no task ${title}`);
  return task.id;
}

interface Panel {
  version: number;
  custom: boolean;
  timed: boolean;
  summary: string;
  items: { code: string; label: string }[];
  presets: { code: string; label: string; on: boolean }[];
}

async function otherUser(world: World) {
  await world.send("/start", OTHER_USER);
  await env.DB.prepare("UPDATE users SET setup_step = 'done' WHERE telegram_user_id = ?")
    .bind(OTHER_USER)
    .run();
}

describe("Mini App reminders", () => {
  it("shows a task's reminders, replaces them, and replays a repeated key", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await world.send("Send report by Mon 3pm");
    const id = await taskId("Send report");
    const detail = await appApi(world, `tasks/${id}`);
    const panel = detail.body.reminders as Panel;
    expect(panel).toMatchObject({ version: 0, custom: false, summary: "1 hour before (default)" });
    expect(panel.presets.map((p) => [p.label, p.on])).toEqual([
      ["10 min", false],
      ["30 min", false],
      ["1 hour", true],
      ["2 hours", false],
      ["1 day", false],
    ]);

    const k = key();
    const body = {
      key: k,
      target: { kind: "task", taskId: id },
      version: 0,
      action: "set",
      codes: ["b1440", "b60"],
    };
    const set = await appApi(world, "reminders", { method: "POST", body });
    expect(set.status).toBe(200);
    expect((set.body.reminders as Panel).summary).toBe("1 day before; 1 hour before");
    const replay = await appApi(world, "reminders", { method: "POST", body });
    expect(replay.body).toMatchObject({ replayed: true });

    // The version shown before the change is now stale.
    const stale = await appApi(world, "reminders", {
      method: "POST",
      body: { ...body, key: key(), codes: ["b10"] },
    });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ error: "stale", reminders: { custom: true } });
  });

  it("adds typed reminders, explains mistakes, and goes back to the default", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await world.send("Pay rent by Mon");
    const id = await taskId("Pay rent");
    const target = { kind: "task", taskId: id };
    const first = (await appApi(world, `tasks/${id}`)).body.reminders as Panel;
    expect(first).toMatchObject({ timed: false, summary: "None; in the 8am agenda on the day" });

    const bad = await appApi(world, "reminders", {
      method: "POST",
      body: { key: key(), target, version: 0, action: "add", text: "2h" },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("bad_reminder");

    const added = await appApi(world, "reminders", {
      method: "POST",
      body: { key: key(), target, version: 0, action: "add", text: "day before 6pm, Sun 9am" },
    });
    const panel = added.body.reminders as Panel;
    expect(panel.items.map((i) => i.label)).toEqual(["Sun 27 Sep at 9am", "1 day before at 6pm"]);

    const back = await appApi(world, "reminders", {
      method: "POST",
      body: { key: key(), target, version: panel.version, action: "default" },
    });
    expect(back.body.reminders).toMatchObject({ custom: false, version: 0 });
  });

  it("refuses a new reminder whose time has passed", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await world.send("Call back by 10am");
    const result = await appApi(world, "reminders", {
      method: "POST",
      body: {
        key: key(),
        target: { kind: "task", taskId: await taskId("Call back") },
        version: 0,
        action: "set",
        codes: ["b120"],
      },
    });
    expect(result).toMatchObject({
      status: 400,
      body: { error: "bad_reminder", message: "2 hours before: that time has passed." },
    });
  });

  it("reads and sets an event's reminders, keeping its start", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    ownerCalendar(world).seed(PRIMARY.calendarId, "dinner", {
      summary: "Dinner",
      start: { dateTime: "2026-09-28T19:00:00+08:00", timeZone: "Asia/Singapore" },
      end: { dateTime: "2026-09-28T20:00:00+08:00", timeZone: "Asia/Singapore" },
    });
    const query = `event-reminders?calendar=${encodeURIComponent(PRIMARY.calendarId)}&event=dinner`;
    const read = await appApi(world, query);
    expect(read.body).toMatchObject({
      title: "Dinner",
      when: "Mon 28 Sep, 7pm",
      reminders: { timed: true, summary: "1 hour before (default)" },
    });
    const set = await appApi(world, "reminders", {
      method: "POST",
      body: {
        key: key(),
        target: { kind: "event", calendarId: PRIMARY.calendarId, eventId: "dinner" },
        version: 0,
        action: "add",
        text: "2 days before 9am",
      },
    });
    expect((set.body.reminders as Panel).summary).toBe("2 days before at 9am; 1 hour before");
    const [stored] = await rows<{ anchor_at: number; rules: string }>(
      env.DB,
      "SELECT anchor_at, rules FROM reminder_overrides",
    );
    expect(stored).toEqual({
      anchor_at: Date.UTC(2026, 8, 28, 11),
      rules: JSON.stringify(["b60", "d2@09:00"]),
    });
  });

  it("keeps each user to their own tasks and calendars", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await world.send("Send report by Mon 3pm");
    await otherUser(world);
    const id = await taskId("Send report");
    const task = await appApi(world, "reminders", {
      method: "POST",
      as: OTHER_USER,
      body: {
        key: key(),
        target: { kind: "task", taskId: id },
        version: 0,
        action: "set",
        codes: [],
      },
    });
    expect(task.status).toBe(404);
    const event = await appApi(
      world,
      `event-reminders?calendar=${encodeURIComponent(PRIMARY.calendarId)}&event=dinner`,
      { as: OTHER_USER },
    );
    expect(event.status).toBe(404);
    expect(await rows(env.DB, "SELECT 1 FROM reminder_overrides")).toEqual([]);
  });
});
