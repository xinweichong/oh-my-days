import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { CalendarEvent } from "../../src/calendar/port";
import { SYNC_INTERVAL_MS } from "../../src/jobs/calendar-sync";
import { rows } from "../support/db";
import { OTHER_USER } from "../support/fakes";
import { ownerCalendar, setUpOwner, World } from "../support/world";

// The world clock starts at Fri 25 Sep 2026, 09:00 in Singapore.

async function taskCalendarId(): Promise<string> {
  const [user] = await rows<{ task_calendar_id: string }>(
    env.DB,
    "SELECT task_calendar_id FROM users",
  );
  if (!user) throw new Error("no user");
  return user.task_calendar_id;
}

async function markers(world: World): Promise<CalendarEvent[]> {
  const id = await taskCalendarId();
  return [...ownerCalendar(world).events.values()].filter(
    (e) => e.calendarId === id && e.status !== "cancelled",
  );
}

async function task(title: string) {
  const [row] = await rows<{
    id: string;
    status: string;
    due_kind: string;
    due_date: string | null;
    title: string;
    list: string;
  }>(
    env.DB,
    `SELECT t.id, t.status, t.due_kind, t.due_date, t.title, l.name AS list
     FROM tasks t JOIN task_lists l ON l.id = t.list_id WHERE t.title = ?`,
    title,
  );
  return row;
}

async function addTask(
  world: World,
  title: string,
  due: string | null,
  time: string | null = null,
  list = "Inbox",
) {
  await world.send("/task");
  await world.press("New task");
  await world.send(title);
  if (world.lastText()?.startsWith("Which list")) await world.press(list);
  if (due === null) return world.press("No deadline");
  await world.press(due);
  if (time === null) await world.press("Any time that day");
  else await world.send(time);
  return world.noRepeat();
}

async function syncLater(world: World) {
  world.clock.advance(SYNC_INTERVAL_MS);
  await world.tick();
}

async function openTask(world: World, label: RegExp) {
  await world.send("/tasks");
  await world.press(label);
}

describe("tasks", () => {
  it("adds an open-ended Inbox task with no calendar entry", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await addTask(world, "Buy milk", null);
    expect(world.lastText()).toBe("Task added to Inbox: Buy milk.\nNo deadline.");
    expect(await markers(world)).toHaveLength(0);
    expect(await task("Buy milk")).toMatchObject({
      status: "open",
      due_kind: "none",
      list: "Inbox",
    });
  });

  it("projects a date-only deadline as a free, silent all-day marker", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await addTask(world, "Buy milk", "Tomorrow · Sat 26 Sep");
    expect(world.lastText()).toBe("Task added to Inbox: Buy milk.\nDue Sat 26 Sep.");

    const [marker] = await markers(world);
    expect(marker?.fields).toEqual({
      summary: "[Inbox] Buy milk",
      start: { date: "2026-09-26" },
      end: { date: "2026-09-27" },
    });
    const extras = ownerCalendar(world).extras.get(`${marker?.calendarId}/${marker?.id}`);
    expect(extras).toMatchObject({ transparent: true, silent: true });
  });

  it("preserves an exact due time with a zero-length marker", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await addTask(world, "Send report", "Tomorrow · Sat 26 Sep", "3pm");
    expect(world.lastText()).toBe("Task added to Inbox: Send report.\nDue Sat 26 Sep, 3pm.");
    const [marker] = await markers(world);
    const at = { dateTime: "2026-09-26T15:00:00+08:00", timeZone: "Asia/Singapore" };
    expect(marker?.fields.start).toEqual(at);
    expect(marker?.fields.end).toEqual(at);
  });

  it("keeps the marker with a ✓ when completed in Telegram", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await addTask(world, "Buy milk", "Tomorrow · Sat 26 Sep");
    await openTask(world, /Buy milk/);
    await world.press("Done");
    expect(world.lastText()).toBe("Completed: Buy milk.");
    expect((await markers(world))[0]?.fields.summary).toBe("✓ [Inbox] Buy milk");
    expect((await task("Buy milk"))?.status).toBe("completed");
  });

  it("completes and reopens a task when ✓ is added and removed in Calendar", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await addTask(world, "Buy milk", "Tomorrow · Sat 26 Sep");
    await syncLater(world);
    const [marker] = await markers(world);
    if (!marker) throw new Error("no marker");

    ownerCalendar(world).externalEdit(marker.calendarId, marker.id, {
      summary: "✓ [Inbox] Buy milk",
    });
    await syncLater(world);
    expect((await task("Buy milk"))?.status).toBe("completed");

    ownerCalendar(world).externalEdit(marker.calendarId, marker.id, {
      summary: "[Inbox] Buy milk",
    });
    await syncLater(world);
    expect((await task("Buy milk"))?.status).toBe("open");
  });

  it("cancels the task when its marker is deleted in Calendar", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await addTask(world, "Buy milk", "Tomorrow · Sat 26 Sep");
    await syncLater(world);
    const [marker] = await markers(world);
    if (!marker) throw new Error("no marker");
    ownerCalendar(world).externalDelete(marker.calendarId, marker.id);
    await syncLater(world);
    expect((await task("Buy milk"))?.status).toBe("cancelled");
  });

  it("removing a deadline in Telegram removes the marker without cancelling the task", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await addTask(world, "Buy milk", "Tomorrow · Sat 26 Sep");
    await syncLater(world);
    await openTask(world, /Buy milk/);
    await world.press("Edit");
    await world.press("Remove deadline");
    expect(world.lastText()).toBe("Deadline removed: Buy milk. No deadline.");
    expect(await markers(world)).toHaveLength(0);
    await syncLater(world); // the deletion's echo
    expect(await task("Buy milk")).toMatchObject({ status: "open", due_kind: "none" });
  });

  it("imports title and deadline edits made in Calendar", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await addTask(world, "Buy milk", "Tomorrow · Sat 26 Sep");
    await syncLater(world);
    const [marker] = await markers(world);
    if (!marker) throw new Error("no marker");
    ownerCalendar(world).externalEdit(marker.calendarId, marker.id, {
      summary: "[Inbox] Buy oat milk",
      start: { date: "2026-09-28" },
      end: { date: "2026-09-29" },
    });
    await syncLater(world);
    expect(await task("Buy oat milk")).toMatchObject({ due_kind: "date", due_date: "2026-09-28" });
  });

  it("turns entries created in the task calendar into tasks, without inventing lists", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await world.send("/task");
    await world.press("Lists");
    await world.press("New list");
    await world.send("Work");
    const calendarId = await taskCalendarId();
    ownerCalendar(world).seed(calendarId, "ext1", {
      summary: "[work] Submit expenses",
      start: { date: "2026-09-30" },
      end: { date: "2026-10-01" },
    });
    ownerCalendar(world).seed(calendarId, "ext2", {
      summary: "[Garden] Plant bulbs",
      start: { date: "2026-10-01" },
      end: { date: "2026-10-02" },
    });
    await syncLater(world);

    expect(await task("Submit expenses")).toMatchObject({ list: "Work", due_date: "2026-09-30" });
    expect(await task("[Garden] Plant bulbs")).toMatchObject({ list: "Inbox" });
    await world.tick(); // the queued marker rewrites run
    const lists = await rows<{ name: string }>(env.DB, "SELECT name FROM task_lists ORDER BY name");
    expect(lists.map((l) => l.name)).toEqual(["Inbox", "Work"]);
    // Markers are rewritten in the standard form and marked free.
    expect(ownerCalendar(world).live(calendarId, "ext1")?.fields.summary).toBe(
      "[Work] Submit expenses",
    );
    expect(ownerCalendar(world).meta.get(`${calendarId}/ext1`)?.transparent).toBe(true);
    await syncLater(world); // echoes change nothing
    expect((await rows(env.DB, "SELECT id FROM tasks")).length).toBe(2);
  });

  it("moves tasks between lists and back to Inbox when a list is deleted", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await world.send("/task");
    await world.press("Lists");
    await world.press("New list");
    await world.send("Work");
    await addTask(world, "Submit expenses", "Tomorrow · Sat 26 Sep");
    await openTask(world, /Submit expenses/);
    await world.press("Edit");
    await world.press("Move to list");
    await world.press("Work");
    expect(world.lastText()).toBe("Moved Submit expenses to Work.");
    expect((await markers(world))[0]?.fields.summary).toBe("[Work] Submit expenses");

    await world.send("/task");
    await world.press("Lists");
    await world.press("Work (1 open)");
    await world.press("Delete list Work");
    expect(world.lastText()).toContain("Its 1 open tasks move to Inbox");
    await world.press("Delete list");
    expect(await task("Submit expenses")).toMatchObject({ list: "Inbox", status: "open" });
    await world.tick();
    expect((await markers(world))[0]?.fields.summary).toBe("[Inbox] Submit expenses");
  });

  it("confirms cancellation, and can restore the task", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await addTask(world, "Buy milk", "Tomorrow · Sat 26 Sep");
    await openTask(world, /Buy milk/);
    await world.press("Cancel task");
    expect(world.lastText()).toBe(
      "Cancel task: Buy milk? Its deadline is removed from Google Calendar.",
    );
    expect((await task("Buy milk"))?.status).toBe("open");
    await world.press("Cancel task");
    expect((await task("Buy milk"))?.status).toBe("cancelled");
    expect(await markers(world)).toHaveLength(0);

    await world.press("Restore");
    expect((await task("Buy milk"))?.status).toBe("open");
    expect(await markers(world)).toHaveLength(1);
  });

  it("undoes a rename only while nothing has changed since", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await addTask(world, "Buy milk", null);
    await openTask(world, /Buy milk/);
    await world.press("Edit");
    await world.press("Rename");
    await world.send("Buy oat milk");
    expect(world.lastText()).toBe("Renamed: Buy oat milk.");
    const undo = world.findButton("Undo");

    await openTask(world, /Buy oat milk/);
    await world.press("Done");
    if (!("callback_data" in undo)) throw new Error("expected a callback button");
    await world.webhook(
      (await import("../support/telegram")).callbackUpdate(1001, undo.callback_data),
    );
    expect(world.answers().at(-1)).toBe("Undo isn't available: the task changed since.");
    expect((await task("Buy oat milk"))?.status).toBe("completed");
  });

  it("reports, without overwriting, a field changed in both places", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await addTask(world, "Buy milk", "Tomorrow · Sat 26 Sep");
    await syncLater(world);
    const [marker] = await markers(world);
    if (!marker) throw new Error("no marker");

    // The rename's marker update fails, so it is still pending when Calendar changes.
    ownerCalendar(world).inject({
      method: "get",
      mode: "error",
      error: { kind: "retryable", retryAfterMs: null },
    });
    await openTask(world, /Buy milk/);
    await world.press("Edit");
    await world.press("Rename");
    await world.send("Buy oat milk");
    ownerCalendar(world).externalEdit(marker.calendarId, marker.id, {
      summary: "[Inbox] Buy soy milk",
    });
    await syncLater(world);

    expect(world.texts()).toContain(
      'Buy oat milk changed in Calendar to "[Inbox] Buy soy milk" while your change was pending. Nothing was overwritten. Which should I keep?',
    );
    expect((await task("Buy oat milk"))?.title).toBe("Buy oat milk");
    expect(ownerCalendar(world).live(marker.calendarId, marker.id)?.fields.summary).toBe(
      "[Inbox] Buy soy milk",
    );
  });

  it("keeps each user's tasks private", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await addTask(world, "Buy milk", null);
    await world.send("/tasks");
    await world.press(/Buy milk/, OTHER_USER);
    expect(world.answers().at(-1)).toBe("This button is no longer valid.");
  });
});

describe("task ordering", () => {
  it("orders by deadline in the user's zone, then tasks without deadlines", async () => {
    const { sortByDeadline } = await import("../../src/application/task-flow");
    const base = {
      userId: "u",
      listId: "l",
      listName: "Inbox",
      status: "open" as const,
      version: 1,
      projection: null,
      projected: null,
      snoozedUntil: null,
      seriesId: null,
      occurrenceDate: null,
    };
    const sorted = sortByDeadline(
      [
        { ...base, id: "a", title: "No deadline", deadline: { kind: "none" } },
        { ...base, id: "b", title: "Sat date", deadline: { kind: "date", date: "2026-09-26" } },
        {
          ...base,
          id: "c",
          title: "Fri 3pm",
          deadline: { kind: "datetime", at: Date.UTC(2026, 8, 25, 7), timeZone: "Asia/Singapore" },
        },
      ],
      "Asia/Singapore",
    );
    expect(sorted.map((t) => t.title)).toEqual(["Fri 3pm", "Sat date", "No deadline"]);
  });
});
