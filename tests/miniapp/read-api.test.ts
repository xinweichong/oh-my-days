import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { SYNC_INTERVAL_MS } from "../../src/jobs/calendar-sync";
import { rows } from "../support/db";
import { OTHER_USER, STRANGER } from "../support/fakes";
import { appApi, initDataFor } from "../support/miniapp";
import { ownerCalendar, PRIMARY, setUpOwner, World } from "../support/world";

// World time starts at Fri 25 Sep 2026, 09:00 in Singapore. Synthetic data only.
const at = (day: number, hour: number) => ({
  dateTime: `2026-09-${day}T${String(hour).padStart(2, "0")}:00:00+08:00`,
  timeZone: "Asia/Singapore",
});

async function fixtures(world: World) {
  const calendar = ownerCalendar(world);
  calendar.seed(PRIMARY.calendarId, "standup", {
    summary: "Standup",
    start: at(25, 9),
    end: at(25, 10),
  });
  calendar.seed(PRIMARY.calendarId, "review", {
    summary: "Review",
    start: at(25, 14),
    end: at(25, 15),
  });
  calendar.seed(PRIMARY.calendarId, "holiday", {
    summary: "Holiday",
    start: { date: "2026-09-28" },
    end: { date: "2026-09-29" },
  });
  world.clock.advance(SYNC_INTERVAL_MS);
  await world.tick();
  await world.send("Send invoice by 5pm");
  await world.send("Pay rent by 24 Sep 2026"); // overdue
  await world.send("Plan trip by Wed");
  await world.send("Buy milk");
}

describe("Mini App sign-in (ADR 0005)", () => {
  it("refuses requests without valid, fresh, allowlisted initData", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    const missing = await world.request("/app/api/home");
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ error: "unauthorized", reason: "missing" });

    const otherBot = await initDataFor(world, undefined, { token: "another-bot-token" });
    expect((await appApi(world, "home", { initData: otherBot })).status).toBe(401);
    const stale = await initDataFor(world, undefined, { ageSeconds: 3601 });
    expect(await appApi(world, "home", { initData: stale })).toEqual({
      status: 401,
      body: { error: "expired" },
    });
    expect((await appApi(world, "home", { as: STRANGER })).status).toBe(401);
    // Allowlisted but never started the bot: no account, nothing revealed.
    expect((await appApi(world, "home", { as: OTHER_USER })).status).toBe(401);
  });

  it("asks a user who hasn't finished setup to do so in the chat", async () => {
    const world = new World(env.DB);
    await world.send("/start", OTHER_USER);
    expect(await appApi(world, "home", { as: OTHER_USER })).toEqual({
      status: 409,
      body: { error: "setup_incomplete" },
    });
  });

  it("serves the page with a strict policy and the script", async () => {
    const world = new World(env.DB);
    const page = await world.request("/app");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain(
      "script-src 'self' https://telegram.org",
    );
    expect(await page.text()).toContain('<script src="/app/app.js" defer></script>');
    const script = await world.request("/app/app.js");
    expect(script.headers.get("content-type")).toContain("text/javascript");
    expect((await script.text()).length).toBeGreaterThan(1000);
  });

  it("serves its own display font, cached by content, and nothing from elsewhere (ADR 0007)", async () => {
    const world = new World(env.DB);
    const page = await world.request("/app");
    const policy = page.headers.get("content-security-policy") ?? "";
    expect(policy).toContain("font-src 'self'");
    const path = /href="(\/app\/figtree-[0-9a-f]{10}\.woff2)"/.exec(await page.text())?.[1];
    expect(path).toBeDefined();
    const font = await world.request(path ?? "");
    expect(font.status).toBe(200);
    expect(font.headers.get("content-type")).toBe("font/woff2");
    expect(font.headers.get("cache-control")).toContain("immutable");
    const bytes = new Uint8Array(await font.arrayBuffer());
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("wOF2");
    // Any other name is unknown, so an old or guessed URL reveals nothing.
    expect((await world.request("/app/figtree-0000000000.woff2")).status).toBe(404);
  });
});

describe("Mini App reads", () => {
  it("shows Home with Next up, tile counts, lists, and sync status", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await fixtures(world);
    world.clock.current = Date.UTC(2026, 8, 25, 5, 0); // 1pm Singapore
    const { status, body } = await appApi(world, "home");
    expect(status).toBe(200);
    expect(body).toMatchObject({
      label: "Fri 25 Sep 2026",
      heading: "Friday 25 Sep",
      nextUp: "2pm Review · in 1 hr",
      next: { kind: "event", time: "2pm", title: "Review", when: "in 1 hr" },
      calendarClear: false,
      // "Plan trip by Wed" is next week; Pay rent is overdue, not due this week.
      tiles: { today: { events: 2, tasks: 1 }, overdue: 1, week: 1, noDeadline: 1 },
      lists: [{ name: "Inbox", open: 4, inbox: true }],
      recent: 0,
      reconnect: false,
    });
    expect(String(body.sync)).toMatch(/^Synced/);
  });

  it("gives Home's tiles what they show: progress, overdue age, week days, list overdue (ADR 0007)", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await fixtures(world);
    world.clock.current = Date.UTC(2026, 8, 25, 5, 0); // 1pm Singapore, after Standup
    const { body } = await appApi(world, "home");
    expect(body).toMatchObject({
      // Standup has ended; Review and Send invoice are still ahead.
      tiles: { today: { events: 2, tasks: 1, done: 0, left: 2 }, overdueOldestDays: 1 },
      lists: [{ name: "Inbox", open: 4, overdue: 1 }],
      allClear: false,
      next: {
        title: "Review",
        startsAt: Date.UTC(2026, 8, 25, 6),
        until: "3pm",
        // The wait to Review is counted from when Standup ended.
        since: Date.UTC(2026, 8, 25, 2),
      },
    });
    const week = (body.tiles as { weekDays: { letter: string; today: boolean; count: number }[] })
      .weekDays;
    expect(week.map((d) => d.letter).join("")).toBe("MTWTFSS");
    expect(week.map((d) => d.count)).toEqual([0, 0, 0, 0, 1, 0, 0]);
    expect(week.findIndex((d) => d.today)).toBe(4);
  });

  it("calls the day clear only once everything today is behind you and nothing is overdue", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await fixtures(world);
    world.clock.current = Date.UTC(2026, 8, 25, 8, 0); // 4pm Singapore, after Review
    const tasks = await rows<{ id: string; version: number; title: string }>(
      env.DB,
      "SELECT id, version, title FROM tasks WHERE title IN ('Send invoice', 'Pay rent')",
    );
    const complete = async (title: string, k: string) => {
      const task = tasks.find((t) => t.title === title);
      return appApi(world, `tasks/${task?.id}/complete`, {
        method: "POST",
        body: { key: k, version: task?.version },
      });
    };
    expect((await complete("Send invoice", "test-key-clear-0001")).status).toBe(200);
    // Today's things are behind you, but Pay rent is still overdue.
    let home = await appApi(world, "home");
    expect(home.body).toMatchObject({
      tiles: { today: { events: 2, tasks: 0, done: 1, left: 0 }, overdue: 1 },
      allClear: false,
    });
    expect((await complete("Pay rent", "test-key-clear-0002")).status).toBe(200);
    home = await appApi(world, "home");
    expect(home.body).toMatchObject({ tiles: { overdueOldestDays: null }, allClear: true });
  });

  it("shows Today with the same events and tasks as /daily", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await fixtures(world);
    const { body } = await appApi(world, "today");
    expect(body).toMatchObject({ date: "2026-09-25", live: true, openEnded: 1 });
    const names = (list: unknown) => (list as { title: string }[]).map((x) => x.title);
    expect(names(body.timed)).toEqual(["Standup", "Review"]);
    expect(names(body.overdue)).toEqual(["Pay rent"]);
    // Overdue tasks carry their age in the user's days; others carry none.
    expect((body.overdue as { overdueLabel: string }[])[0]?.overdueLabel).toBe("1 day overdue");
    expect((body.due as { overdueLabel: string | null }[])[0]?.overdueLabel).toBeNull();
    expect(names(body.due)).toEqual(["Send invoice"]);
    await world.send("/daily");
    const daily = world.lastText() ?? "";
    for (const title of ["Standup", "Review", "Pay rent", "Send invoice"]) {
      expect(daily).toContain(title);
    }
    expect(daily).toContain("1 task without a deadline");
  });

  it("shows the Week like /weekly, with navigation", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await fixtures(world);
    const { body } = await appApi(world, "week");
    expect(body).toMatchObject({
      start: "2026-09-21",
      previous: "2026-09-14",
      next: "2026-09-28",
      live: true,
    });
    const days = body.days as {
      date: string;
      today: boolean;
      events: { title: string }[];
      tasks: { title: string }[];
    }[];
    const friday = days.find((d) => d.date === "2026-09-25");
    expect(friday?.today).toBe(true);
    expect(friday?.events.map((e) => e.title)).toEqual(["Standup", "Review"]);
    expect(friday?.tasks.map((t) => t.title)).toEqual(["Send invoice"]);
    const next = await appApi(world, "week?start=2026-09-28");
    const monday = (
      next.body.days as { date: string; events: { title: string; allDay: boolean }[] }[]
    )[0];
    expect(monday?.events).toMatchObject([{ title: "Holiday", allDay: true }]);
    expect((await appApi(world, "week?start=not-a-date")).status).toBe(400);
  });

  it("labels the saved copy when Google can't be reached", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await fixtures(world);
    ownerCalendar(world).inaccessible.add(PRIMARY.calendarId);
    const { body } = await appApi(world, "today");
    expect(body.live).toBe(false);
    expect((body.timed as { title: string }[]).map((e) => e.title)).toEqual(["Standup", "Review"]);
  });

  it("lists overdue, no-deadline, and list tasks, a task's detail, and Recent", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await fixtures(world);
    const overdue = await appApi(world, "tasks?view=overdue");
    expect(overdue.body.tasks as { title: string; overdue: boolean }[]).toMatchObject([
      { title: "Pay rent", overdue: true },
    ]);
    const none = await appApi(world, "tasks?view=no_deadline");
    expect((none.body.tasks as { title: string }[]).map((t) => t.title)).toEqual(["Buy milk"]);
    const [inbox] = await rows<{ id: string }>(env.DB, "SELECT id FROM task_lists");
    const list = await appApi(world, `tasks?view=list&list=${inbox?.id}`);
    expect(list.body).toMatchObject({ title: "Inbox", showList: false });
    const [task] = await rows<{ id: string }>(
      env.DB,
      "SELECT id FROM tasks WHERE title = 'Send invoice'",
    );
    const detail = await appApi(world, `tasks/${task?.id}`);
    expect(detail.body).toMatchObject({
      task: { title: "Send invoice", deadline: { kind: "datetime", label: "Due Fri 25 Sep, 5pm" } },
      reminders: { summary: "1 hour before (default)", custom: false, timed: true, version: 0 },
    });
    expect((await appApi(world, "recent")).body).toMatchObject({ days: 30, tasks: [] });
  });

  it("tells task screens the user's local day and time, and how each series repeats", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await world.send("/task");
    await world.press("New task");
    await world.send("Water plants");
    await world.press("Today · Fri 25 Sep");
    await world.press("Any time that day");
    await world.press("Weekly");
    await world.tick();
    const [inbox] = await rows<{ id: string }>(env.DB, "SELECT id FROM task_lists");
    const [series] = await rows<{ id: string }>(env.DB, "SELECT id FROM task_series");
    const list = await appApi(world, `tasks?view=list&list=${inbox?.id}`);
    // 9am Friday 25 Sep in Singapore, whatever zone the phone is in.
    const local = { today: "2026-09-25", time: "09:00", agendaHour: expect.any(Number) };
    expect(list.body).toMatchObject({ local, series: { [series?.id ?? ""]: expect.any(String) } });
    expect(String((list.body.series as Record<string, string>)[series?.id ?? ""])).toMatch(/week/i);
    const [task] = await rows<{ id: string }>(env.DB, "SELECT id FROM tasks LIMIT 1");
    expect((await appApi(world, `tasks/${task?.id}`)).body).toMatchObject({ local });
    for (const path of ["home", "today", "week"]) {
      expect((await appApi(world, path)).body).toMatchObject({ local });
    }
  });
});

describe("Mini App cross-user isolation", () => {
  it("never shows one user's tasks or lists to another", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await fixtures(world);
    await world.send("/start", OTHER_USER);
    await env.DB.prepare("UPDATE users SET setup_step = 'done' WHERE telegram_user_id = ?")
      .bind(OTHER_USER)
      .run();
    const [task] = await rows<{ id: string }>(env.DB, "SELECT id FROM tasks LIMIT 1");
    const [list] = await rows<{ id: string }>(env.DB, "SELECT id FROM task_lists LIMIT 1");
    expect((await appApi(world, `tasks/${task?.id}`, { as: OTHER_USER })).status).toBe(404);
    expect(
      (await appApi(world, `tasks?view=list&list=${list?.id}`, { as: OTHER_USER })).status,
    ).toBe(404);
    const home = await appApi(world, "home", { as: OTHER_USER });
    expect(home.body).toMatchObject({ lists: [], tiles: { overdue: 0, noDeadline: 0 } });
  });
});
