import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { rows } from "../support/db";
import { OTHER_USER } from "../support/fakes";
import { ownerCalendar, PRIMARY, setUpOwner, World } from "../support/world";

// World time starts at Fri 25 Sep 2026, 09:00 in Singapore.
const sg = (local: string) => ({ dateTime: `${local}+08:00`, timeZone: "Asia/Singapore" });

function eventNamed(world: World, title: string) {
  return [...ownerCalendar(world).events.values()].find((e) => e.fields.summary === title);
}

async function startEvent(world: World, title: string) {
  await world.send("/event");
  await world.press("New event");
  await world.send(title);
}

describe("typed weekdays and relative dates in guided input", () => {
  it("asks which Friday on a Friday, then takes a time range without asking the length", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await startEvent(world, "Dinner");
    await world.send("fri");
    expect(world.lastText()).toBe("Which Friday?");
    expect(world.findButton("Today · Fri 25 Sep")).toBeTruthy();
    await world.press("Fri 2 Oct");
    await world.send("7-9pm");
    await world.noRepeat();
    expect(world.lastText()).toBe("Event added: Dinner\nFri 2 Oct 2026, 7–9pm · owner@example.com");
    expect(eventNamed(world, "Dinner")?.fields.end).toEqual(sg("2026-10-02T21:00:00"));
  });

  it("asks am or pm for a bare hour instead of guessing", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await startEvent(world, "Call");
    await world.send("in 3 days");
    expect(world.lastText()).toContain("What time on Mon 28 Sep?");
    await world.send("at 3");
    expect(world.lastText()).toBe("3am or 3pm?");
    expect(ownerCalendar(world).events.size).toBe(0);
    await world.press("3pm");
    await world.press("1 hour");
    await world.noRepeat();
    expect(world.lastText()).toBe("Event added: Call\nMon 28 Sep 2026, 3–4pm · owner@example.com");
  });

  it("still accepts a typed answer while a choice is shown", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await startEvent(world, "Dinner");
    await world.send("next fri");
    // On a Friday, next Friday is a week away either way.
    expect(world.lastText()).toContain("What time on Fri 2 Oct?");
  });

  it("sets task deadlines from relative dates and asked hours", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await world.send("/task");
    await world.press("New task");
    await world.send("Send invoice");
    await world.send("next week");
    expect(world.lastText()).toContain("Due at a specific time on Mon 28 Sep?");
    await world.send("3");
    await world.press("3pm");
    await world.noRepeat();
    expect(world.lastText()).toBe("Task added to Inbox: Send invoice.\nDue Mon 28 Sep, 3pm.");
  });

  it("refuses a past 'this <weekday>' and asks again", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await world.send("/task");
    await world.press("New task");
    await world.send("Send invoice");
    await world.send("this wed");
    expect(world.lastText()).toContain("I didn't recognize that date");
    await world.send("end of month");
    expect(world.lastText()).toContain("Due at a specific time on Wed 30 Sep?");
  });
});

describe("follow-ups with the shared date grammar", () => {
  async function inboxTask(world: World, title: string) {
    await world.send("/task");
    await world.press("New task");
    await world.send(title);
    await world.press("No deadline");
  }

  it("accepts 'make that <weekday>' for the last item", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await inboxTask(world, "Pay rent");
    await world.send("Actually, make that Monday");
    expect(world.lastText()).toBe("Deadline for Pay rent: Mon 28 Sep.");
  });

  it("asks which Friday and applies the chosen one", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await inboxTask(world, "Pay rent");
    await world.send("make that Friday");
    expect(world.lastText()).toBe("Which Friday?");
    const [before] = await rows<{ due_kind: string }>(env.DB, "SELECT due_kind FROM tasks");
    expect(before?.due_kind).toBe("none");
    await world.press("Fri 2 Oct");
    expect(world.lastText()).toBe("Deadline for Pay rent: Fri 2 Oct.");
  });

  it("moves an event to the chosen hour", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await startEvent(world, "Dinner");
    await world.press("Tomorrow · Sat 26 Sep");
    await world.send("7pm");
    await world.press("1 hour");
    await world.noRepeat();
    await world.send("move it to 8");
    expect(world.lastText()).toBe("8am or 8pm?");
    await world.press("8pm");
    expect(world.lastText()).toBe(
      "Event updated: Dinner\nSat 26 Sep 2026, 8–9pm · owner@example.com",
    );
  });

  it("refuses another user's choice button", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await inboxTask(world, "Pay rent");
    await world.send("make that Friday");
    await world.press("Fri 2 Oct", OTHER_USER);
    expect(world.answers().at(-1)).toBe("This button is no longer valid.");
    const [task] = await rows<{ due_kind: string }>(env.DB, "SELECT due_kind FROM tasks");
    expect(task?.due_kind).toBe("none");
  });
});

describe("snoozing to a typed date and time", () => {
  it("asks which Friday, then snoozes without moving the deadline", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await world.send("/task");
    await world.press("New task");
    await world.send("Pay rent");
    await world.press("Today · Fri 25 Sep");
    await world.press("Any time that day");
    await world.noRepeat();
    await world.send("/tasks");
    await world.press(/Pay rent/);
    await world.press("Snooze");
    await world.press("Choose date/time");
    await world.send("fri 9am");
    expect(world.lastText()).toBe("Which Friday?");
    await world.press("Fri 2 Oct, 9am");
    expect(world.lastText()).toContain("Fri 2 Oct");
    const [task] = await rows<{ due_date: string }>(env.DB, "SELECT due_date FROM tasks");
    expect(task?.due_date).toBe("2026-09-25");
  });
});

describe("events keep their calendar", () => {
  it("creates typed-date events in the default calendar", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await startEvent(world, "Lunch");
    await world.send("mon");
    await world.send("noon");
    await world.send("two hours");
    await world.noRepeat();
    expect(world.lastText()).toBe(
      `Event added: Lunch\nMon 28 Sep 2026, 12–2pm · ${PRIMARY.summary}`,
    );
  });
});
