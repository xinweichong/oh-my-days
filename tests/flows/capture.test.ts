import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { count, rows } from "../support/db";
import { OTHER_USER, OWNER } from "../support/fakes";
import { freshUpdateId, textUpdate } from "../support/telegram";
import { ownerCalendar, PRIMARY, setUpOwner, World } from "../support/world";

// World time starts at Fri 25 Sep 2026, 09:00 in Singapore. Synthetic text only.
const sg = (local: string) => ({ dateTime: `${local}+08:00`, timeZone: "Asia/Singapore" });
const WORK = {
  calendarId: "work@group.test",
  summary: "Work",
  accessRole: "writer" as const,
  primary: false,
};

function events(world: World) {
  return [...ownerCalendar(world).events.values()].filter((e) => e.status !== "cancelled");
}

function ownEvents(world: World, title: string) {
  return events(world).filter((e) => e.fields.summary === title);
}

async function tasks() {
  return rows<{ title: string; status: string; due_kind: string; due_date: string | null }>(
    env.DB,
    "SELECT title, status, due_kind, due_date FROM tasks ORDER BY created_at",
  );
}

describe("quick capture: one message creates the right item", () => {
  it("creates an event with the default length, Undo, and a switch", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await world.send("Dinner Sat 7pm");
    expect(world.lastText()).toBe(
      "Event added: Dinner\nSat 26 Sep 2026, 7–8pm · owner@example.com",
    );
    expect(world.findButton("Undo")).toBeTruthy();
    expect(world.findButton("Make it a task")).toBeTruthy();
    const [dinner] = ownEvents(world, "Dinner");
    expect(dinner?.fields.start).toEqual(sg("2026-09-26T19:00:00"));
    expect(dinner?.fields.end).toEqual(sg("2026-09-26T20:00:00"));
  });

  it("reads 'Call Alex tomorrow at 3pm' as an event", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await world.send("Call Alex tomorrow at 3pm");
    expect(world.lastText()).toBe(
      "Event added: Call Alex\nSat 26 Sep 2026, 3–4pm · owner@example.com",
    );
  });

  it("creates a task due tomorrow for 'Remind me to buy milk tomorrow'", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await world.send("Remind me to buy milk tomorrow");
    expect(world.lastText()).toBe("Task added to Inbox: Buy milk.\nDue Sat 26 Sep.");
    expect(world.findButton("Make it an event")).toBeTruthy();
    await world.tick();
    const markers = events(world).filter((e) => e.fields.summary === "[Inbox] Buy milk");
    expect(markers).toHaveLength(1);
    expect(markers[0]?.fields.start).toEqual({ date: "2026-09-26" });
  });

  it("creates an open-ended Inbox task with no calendar entry for 'Buy milk'", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await world.send("Buy milk");
    expect(world.lastText()).toBe("Task added to Inbox: Buy milk.\nNo deadline.");
    await world.tick();
    expect(events(world).some((e) => e.fields.summary.includes("Buy milk"))).toBe(false);
  });

  it("uses an existing list and calendar named in the message, and only those", async () => {
    const world = new World(env.DB);
    await setUpOwner(world, [PRIMARY, WORK], ["Work"]);
    await world.send("/task");
    await world.press("Lists");
    await world.press("New list");
    await world.send("Errands");
    await world.send("Add post parcel to errands, due Mon");
    expect(world.lastText()).toBe("Task added to Errands: Post parcel.\nDue Mon 28 Sep.");
    await world.send("Standup on work mon 10am");
    expect(world.lastText()).toBe("Event added: Standup\nMon 28 Sep 2026, 10–11am · Work");
    await world.send("Send report to Alex");
    expect(world.lastText()).toBe("Task added to Inbox: Send report to Alex.\nNo deadline.");
  });

  it("never matches another user's list or calendar names", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await world.send("/start", OTHER_USER);
    const [other] = await rows<{ id: string }>(
      env.DB,
      "SELECT id FROM users WHERE telegram_user_id = ?",
      OTHER_USER,
    );
    const now = world.clock.now();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO task_lists (id, user_id, name, normalized_name, created_at, updated_at) VALUES ('other-list', ?, 'Secret', 'secret', ?, ?)",
      ).bind(other?.id, now, now),
      env.DB.prepare(
        "INSERT INTO calendars (user_id, calendar_id, summary, access_role, selected, updated_at) VALUES (?, 'other-cal', 'Hidden', 'owner', 1, ?)",
      ).bind(other?.id, now),
    ]);
    await world.send("Plan party to secret");
    expect(world.lastText()).toBe("Task added to Inbox: Plan party to secret.\nNo deadline.");
    await world.send("Picnic on hidden mon 1pm");
    expect(world.lastText()).toBe(
      "Event added: Picnic on hidden\nMon 28 Sep 2026, 1–2pm · owner@example.com",
    );
  });

  it("creates once when Telegram redelivers the same message", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    const update = textUpdate(OWNER, "Dinner Sat 7pm", { updateId: freshUpdateId() });
    await world.webhook(update);
    await world.webhook(update);
    await world.tick();
    expect(ownEvents(world, "Dinner")).toHaveLength(1);
    const again = textUpdate(OWNER, "Buy milk", { updateId: freshUpdateId() });
    await world.webhook(again);
    await world.webhook(again);
    expect((await tasks()).filter((t) => t.title === "Buy milk")).toHaveLength(1);
  });

  it("makes the created item the one follow-ups refer to", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await world.send("Dinner Sat 7pm");
    await world.send("move it to 8pm");
    expect(world.lastText()).toBe(
      "Event updated: Dinner\nSat 26 Sep 2026, 8–9pm · owner@example.com",
    );
  });
});

describe("quick capture: questions instead of guesses", () => {
  it("refuses several requests in one message and creates nothing", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await world.send("Lunch Mon at noon, submit expenses Tue, and buy milk");
    expect(world.lastText()).toBe(
      "That's more than one request. Send each one as its own message; nothing was added.",
    );
    await world.tick();
    expect(events(world)).toHaveLength(0);
    expect(await count(env.DB, "tasks")).toBe(0);
  });

  it("asks task or all-day event for a date alone, and acts on the first press only", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await world.send("Dentist Mon");
    expect(world.lastText()).toBe("Dentist: a task due that day, or an all-day event?");
    expect(await count(env.DB, "tasks")).toBe(0);
    await world.press("Task due Mon 28 Sep");
    expect(world.lastText()).toBe("Task added to Inbox: Dentist.\nDue Mon 28 Sep.");
    await world.press("All-day event Mon 28 Sep");
    expect(world.answers().at(-1)).toBe("This button is no longer valid.");
    await world.tick();
    expect(ownEvents(world, "Dentist")).toHaveLength(0);
    expect(await count(env.DB, "tasks")).toBe(1);
  });

  it("creates an all-day event when chosen", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await world.send("Holiday Mon");
    await world.press("All-day event Mon 28 Sep");
    expect(world.lastText()).toBe(
      "Event added: Holiday\nMon 28 Sep 2026 (all day) · owner@example.com",
    );
  });

  it("asks which Friday, and am or pm, with dated buttons", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await world.send("Dinner fri 7pm");
    expect(world.lastText()).toBe("Which Friday?");
    await world.press("Fri 2 Oct, 7pm");
    expect(world.lastText()).toBe("Event added: Dinner\nFri 2 Oct 2026, 7–8pm · owner@example.com");
    await world.send("Call mum tomorrow at 3");
    expect(world.lastText()).toBe("3am or 3pm?");
    await world.press("Tomorrow · Sat 26 Sep, 3pm");
    expect(world.lastText()).toBe(
      "Event added: Call mum\nSat 26 Sep 2026, 3–4pm · owner@example.com",
    );
  });

  it("offers Add as task, Add as event, or Cancel for text it can't read", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await world.send("Move dentist from Mon to Tue");
    expect(world.lastText()).toBe("I couldn't read that as an event or a task.");
    await world.press("Cancel");
    expect(world.lastText()).toBe("Nothing was added.");
    expect(await count(env.DB, "tasks")).toBe(0);

    await world.send("Notes from the call\nAgenda follows");
    await world.press('Add as task "Notes from the call"');
    expect(world.lastText()).toBe("Task added to Inbox: Notes from the call.\nNo deadline.");

    await world.send("???");
    await world.press("Add as event");
    expect(world.lastText()).toContain("Which day is ???");
  });

  it("asks for a title when there is only a date or time", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await world.send("tomorrow 3pm");
    expect(world.lastText()).toBe("What is it called? Add a title, like Dinner Fri 7pm.");
  });

  it("refuses a time that doesn't exist in the user's zone", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await world.send("/settings");
    await world.press("Timezone");
    await world.press("Change timezone");
    await world.send("Europe/London");
    // Clocks in London skip 01:00–02:00 on Sun 28 Mar 2027.
    await world.send("Night run 28 Mar 1:30am");
    expect(world.lastText()).toContain("doesn't exist on Sun 28 Mar in Europe/London");
    await world.tick();
    expect(ownEvents(world, "Night run")).toHaveLength(0);
  });

  it("still sends text to an open guided question first", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await world.send("/event");
    await world.press("New event");
    await world.send("Dinner Sat 7pm");
    expect(world.lastText()).toContain("Which day is Dinner Sat 7pm?");
  });
});

describe("quick capture: switching between event and task", () => {
  it("turns a just-created event into a task after confirmation", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await world.send("Pay rent Sat 7pm");
    await world.press("Make it a task");
    expect(world.lastText()).toBe(
      "Make Pay rent a task instead?\nThis removes the event (Sat 26 Sep 2026, 7–8pm) and adds a task: Due Sat 26 Sep, 7pm.",
    );
    expect(ownEvents(world, "Pay rent")).toHaveLength(1);
    await world.press("Make it a task");
    await world.tick();
    expect(world.texts()).toContain("Removed event: Pay rent.");
    expect(world.lastText()).toBe("Task added to Inbox: Pay rent.\nDue Sat 26 Sep, 7pm.");
    expect(ownEvents(world, "Pay rent")).toHaveLength(0);
    expect((await tasks()).map((t) => [t.title, t.due_kind, t.status])).toEqual([
      ["Pay rent", "datetime", "open"],
    ]);
    // The new task is the item follow-ups now refer to.
    await world.send("done");
    expect(world.lastText()).toBe("Completed: Pay rent.");
  });

  it("keeps the event if it changed in Calendar since it was added", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await world.send("Pay rent Sat 7pm");
    const [created] = ownEvents(world, "Pay rent");
    if (!created) throw new Error("expected the event");
    ownerCalendar(world).externalEdit(PRIMARY.calendarId, created.id, {
      summary: "Pay rent (moved)",
    });
    await world.press("Make it a task");
    await world.press("Make it a task");
    await world.tick();
    expect(world.lastText()).toBe(
      "Pay rent changed in Calendar since it was added, so it stays an event.",
    );
    expect(await count(env.DB, "tasks")).toBe(0);
  });

  it("turns a just-created task into an all-day event after confirmation", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await world.send("task conference Mon");
    await world.press("Make it an event");
    expect(world.lastText()).toBe(
      "Make Conference an event instead?\nThis removes the task and adds an event on Mon 28 Sep (all day).",
    );
    await world.press("Make it an event");
    await world.tick();
    expect(world.texts()).toContain("Removed task: Conference.");
    expect(world.lastText()).toBe(
      "Event added: Conference\nMon 28 Sep 2026 (all day) · owner@example.com",
    );
    expect((await tasks()).map((t) => t.status)).toEqual(["cancelled"]);
  });

  it("keeps the task if it changed since it was added", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await world.send("task conference Mon");
    await world.send("rename it to Summit");
    await world.press("Make it an event");
    expect(world.lastText()).toBe("This task has changed since, so it stays a task.");
    await world.tick();
    expect(ownEvents(world, "Conference")).toHaveLength(0);
  });

  it("refuses another user's switch button", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await world.send("Buy milk");
    await world.press("Make it an event", OTHER_USER);
    expect(world.answers().at(-1)).toBe("This button is no longer valid.");
    expect((await tasks()).map((t) => t.status)).toEqual(["open"]);
  });
});
