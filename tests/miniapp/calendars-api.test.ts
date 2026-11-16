import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { rows } from "../support/db";
import { OTHER_USER } from "../support/fakes";
import { appApi } from "../support/miniapp";
import { PRIMARY, setUpOwner, World } from "../support/world";

// Mini App calendar management. World time starts at Fri 25 Sep 2026, 09:00 in
// Singapore. Synthetic data only.
const WORK = {
  calendarId: "work@group.test",
  summary: "Work",
  accessRole: "writer" as const,
  primary: false,
};
const TEAM = {
  calendarId: "team@group.test",
  summary: "Team",
  accessRole: "reader" as const,
  primary: false,
};

interface View {
  calendars: {
    id: string;
    name: string;
    access: string;
    selected: boolean;
    isDefault: boolean;
    canBeDefault: boolean;
  }[];
  task: { name: string } | null;
}

async function setUp(world: World) {
  await setUpOwner(world, [PRIMARY, WORK, TEAM], ["Work"]);
}

const post = (world: World, path: string, body: Record<string, unknown>, as?: number) =>
  appApi(world, path, { method: "POST", body, ...(as ? { as } : {}) });

describe("Mini App calendars", () => {
  it("lists calendars with what each does, and the task calendar apart", async () => {
    const world = new World(env.DB);
    await setUp(world);
    const { status, body } = await appApi(world, "calendars");
    expect(status).toBe(200);
    const view = body as unknown as View;
    expect(view.calendars.map((c) => [c.name, c.access, c.selected, c.isDefault])).toEqual([
      [PRIMARY.summary, "owner", true, true],
      ["Team", "view", false, false],
      ["Work", "edit", true, false],
    ]);
    expect(view.task?.name).toBe("Tasks - Oh My Days");
    expect(view.calendars.some((c) => c.name === "Tasks - Oh My Days")).toBe(false);
  });

  it("shows and hides a calendar, including a view-only one", async () => {
    const world = new World(env.DB);
    await setUp(world);
    const hide = await post(world, "calendars/select", {
      calendarId: WORK.calendarId,
      selected: false,
    });
    expect(hide.status).toBe(200);
    const after = hide.body as unknown as View;
    expect(after.calendars.find((c) => c.id === WORK.calendarId)?.selected).toBe(false);

    const show = await post(world, "calendars/select", {
      calendarId: TEAM.calendarId,
      selected: true,
    });
    expect(
      (show.body as unknown as View).calendars.find((c) => c.id === TEAM.calendarId)?.selected,
    ).toBe(true);

    // Repeating a change changes nothing further.
    const again = await post(world, "calendars/select", {
      calendarId: TEAM.calendarId,
      selected: true,
    });
    expect(again.status).toBe(200);
  });

  it("will not hide the calendar new events go to", async () => {
    const world = new World(env.DB);
    await setUp(world);
    const refused = await post(world, "calendars/select", {
      calendarId: PRIMARY.calendarId,
      selected: false,
    });
    expect(refused).toMatchObject({ status: 409, body: { error: "is_default" } });
    const [row] = await rows<{ selected: number }>(
      env.DB,
      "SELECT selected FROM calendars WHERE calendar_id = ?",
      PRIMARY.calendarId,
    );
    expect(row?.selected).toBe(1);
  });

  it("changes the default to a writable calendar and shows it; Telegram agrees", async () => {
    const world = new World(env.DB);
    await setUp(world);
    const { status, body } = await post(world, "calendars/default", {
      calendarId: WORK.calendarId,
    });
    expect(status).toBe(200);
    const view = body as unknown as View;
    expect(view.calendars.find((c) => c.isDefault)?.name).toBe("Work");
    await world.send("/settings");
    expect(world.lastText()).toContain("Default for new events: Work");
  });

  it("makes a hidden calendar visible when it becomes the default", async () => {
    const world = new World(env.DB);
    await setUpOwner(world, [PRIMARY, WORK], []);
    await post(world, "calendars/default", { calendarId: WORK.calendarId });
    const { body } = await appApi(world, "calendars");
    expect((body as unknown as View).calendars.find((c) => c.id === WORK.calendarId)).toMatchObject(
      {
        selected: true,
        isDefault: true,
      },
    );
  });

  it("refuses a view-only calendar, the task calendar, and unknown ids as the default", async () => {
    const world = new World(env.DB);
    await setUp(world);
    expect(await post(world, "calendars/default", { calendarId: TEAM.calendarId })).toMatchObject({
      status: 409,
      body: { error: "not_writable" },
    });
    const [task] = await rows<{ task_calendar_id: string }>(
      env.DB,
      "SELECT task_calendar_id FROM users WHERE task_calendar_id IS NOT NULL",
    );
    for (const calendarId of [task?.task_calendar_id ?? "x", "nope@group.test"]) {
      expect((await post(world, "calendars/default", { calendarId })).status).toBe(404);
      expect((await post(world, "calendars/select", { calendarId, selected: false })).status).toBe(
        404,
      );
    }
  });

  it("rejects malformed requests", async () => {
    const world = new World(env.DB);
    await setUp(world);
    expect((await post(world, "calendars/select", { calendarId: WORK.calendarId })).status).toBe(
      400,
    );
    expect((await post(world, "calendars/select", { selected: true })).status).toBe(400);
    expect((await post(world, "calendars/default", {})).status).toBe(400);
    expect((await post(world, "calendars/rename", { calendarId: WORK.calendarId })).status).toBe(
      404,
    );
  });

  it("never touches another user's calendars", async () => {
    const world = new World(env.DB);
    await setUp(world);
    await world.send("/start", OTHER_USER);
    await env.DB.prepare("UPDATE users SET setup_step = 'done' WHERE telegram_user_id = ?")
      .bind(OTHER_USER)
      .run();
    const view = await appApi(world, "calendars", { as: OTHER_USER });
    expect((view.body as unknown as View).calendars).toEqual([]);
    const attempt = await post(
      world,
      "calendars/default",
      { calendarId: WORK.calendarId },
      OTHER_USER,
    );
    expect(attempt.status).toBe(404);
    const select = await post(
      world,
      "calendars/select",
      { calendarId: WORK.calendarId, selected: false },
      OTHER_USER,
    );
    expect(select.status).toBe(404);
    const [work] = await rows<{ selected: number }>(
      env.DB,
      "SELECT selected FROM calendars WHERE calendar_id = ?",
      WORK.calendarId,
    );
    expect(work?.selected).toBe(1);
  });

  it("asks for a sync without exceeding the poll cooldown", async () => {
    const world = new World(env.DB);
    await setUp(world);
    const first = await post(world, "calendars/sync", {});
    expect(first.body).toEqual({ result: "accepted" });
    const second = await post(world, "calendars/sync", {});
    expect(["cooldown", "running"]).toContain((second.body as { result: string }).result);
  });
});
