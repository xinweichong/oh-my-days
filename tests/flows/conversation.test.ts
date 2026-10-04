import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { SYNC_INTERVAL_MS } from "../../src/jobs/calendar-sync";
import { rows } from "../support/db";
import { OWNER } from "../support/fakes";
import { textUpdate } from "../support/telegram";
import { ownerCalendar, PRIMARY, setUpOwner, World } from "../support/world";

// World time starts at Fri 25 Sep 2026, 09:00 in Singapore.
const at = (day: number, hour: number, minute = 0) => ({
  dateTime: `2026-09-${day}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+08:00`,
  timeZone: "Asia/Singapore",
});

async function withDinner(world: World, meta = {}) {
  ownerCalendar(world).seed(
    PRIMARY.calendarId,
    "dinner",
    { summary: "Dinner", start: at(26, 19), end: at(26, 20) },
    meta,
  );
  world.clock.advance(SYNC_INTERVAL_MS);
  await world.tick();
}

async function openDinner(world: World) {
  await world.send("/event");
  await world.press("Change an event");
  await world.press(/Dinner$/);
}

/** The Telegram message ID of the most recent message about an item of this kind. */
async function lastItemMessage(kind: "event" | "task"): Promise<number> {
  const [row] = await rows<{ provider_message_id: number }>(
    env.DB,
    "SELECT provider_message_id FROM telegram_outbox WHERE target LIKE ? AND provider_message_id IS NOT NULL ORDER BY rowid DESC LIMIT 1",
    `%"kind":"${kind}"%`,
  );
  if (!row) throw new Error("no item message");
  return row.provider_message_id;
}

describe("invitations", () => {
  it("previews every recipient and sends nothing until confirmed; unknown names are asked, then saved", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await withDinner(world);
    await openDinner(world);
    await world.press("Invite");
    await world.send("sam@example.com, Alex");
    expect(world.lastText()).toBe(
      "I don't have an email address for Alex. Send it, and I'll offer to save it.",
    );
    await world.send("alex@example.com");
    expect(world.texts()).toContain("Save Alex as alex@example.com for next time?");
    expect(world.lastText()).toBe(
      "Invite to Dinner:\n• sam@example.com\n• alex@example.com\n\nGoogle will email each of them an invitation.",
    );
    const calendar = ownerCalendar(world);
    expect(calendar.notified).toHaveLength(0);

    await world.press("Send invitations");
    expect(calendar.notified).toEqual([{ eventId: "dinner", method: "patch" }]);
    expect(calendar.meta.get(`${PRIMARY.calendarId}/dinner`)?.attendees).toEqual([
      "sam@example.com",
      "alex@example.com",
    ]);
    expect(world.lastText()).toBe(
      "Invitations sent for Dinner:\n• sam@example.com\n• alex@example.com",
    );

    await world.press("Save Alex");
    expect(await rows(env.DB, "SELECT name FROM contacts")).toEqual([{ name: "Alex" }]);
  });

  it("asks again if the guest list changed after confirmation was shown", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await withDinner(world, { attendees: ["sam@example.com"] });
    await openDinner(world);
    await world.press("Invite");
    await world.send("alex@example.com");
    expect(world.lastText()).toContain(
      "The existing guests also get an update:\n• sam@example.com",
    );

    const calendar = ownerCalendar(world);
    calendar.meta.set(`${PRIMARY.calendarId}/dinner`, {
      attendees: ["sam@example.com", "kim@example.com"],
    });
    await world.press("Send invitations");
    expect(calendar.notified).toHaveLength(0);
    expect(world.lastText()).toContain("The guests of Dinner changed since you confirmed.");
    expect(world.lastText()).toContain("• kim@example.com");
    await world.press("Send invitations");
    expect(calendar.notified).toHaveLength(1);
  });
});

describe("events with guests", () => {
  it("confirms changes with the recipients, and Undo is confirmed too", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await withDinner(world, { attendees: ["sam@example.com"] });
    await openDinner(world);
    await world.press("Rename");
    await world.send("Dinner with Sam");
    expect(world.lastText()).toBe(
      "Change Dinner:\nRename to Dinner with Sam\n\nGoogle will email the update to:\n• sam@example.com",
    );
    const calendar = ownerCalendar(world);
    expect(calendar.live(PRIMARY.calendarId, "dinner")?.fields.summary).toBe("Dinner");
    await world.press("Send update");
    expect(calendar.live(PRIMARY.calendarId, "dinner")?.fields.summary).toBe("Dinner with Sam");
    expect(world.lastText()).toContain("Google emailed the update to 1 guest.");

    await world.press("Undo");
    expect(world.lastText()).toContain("Google will email the update to:\n• sam@example.com");
    expect(calendar.live(PRIMARY.calendarId, "dinner")?.fields.summary).toBe("Dinner with Sam");
  });

  it("previews cancellation recipients before deleting", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await withDinner(world, { attendees: ["sam@example.com", "alex@example.com"] });
    await openDinner(world);
    await world.press("Delete");
    expect(world.lastText()).toContain(
      "Google will email a cancellation to:\n• sam@example.com\n• alex@example.com",
    );
    await world.press("Delete and notify");
    expect(ownerCalendar(world).notified).toEqual([{ eventId: "dinner", method: "delete" }]);
  });
});

describe("follow-ups", () => {
  it("applies 'move it to 8pm' to the event in the message being replied to", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await withDinner(world);
    await openDinner(world);
    const replyTo = await lastItemMessage("event");
    await world.send("/help"); // an unrelated message in between
    await world.webhook(textUpdate(OWNER, "move it to 8pm", { replyTo }));
    expect(ownerCalendar(world).live(PRIMARY.calendarId, "dinner")?.fields.start).toEqual(
      at(26, 20),
    );
    expect(world.lastText()).toBe(
      "Event updated: Dinner\nSat 26 Sep 2026, 8–9pm · owner@example.com",
    );
  });

  it("uses the most recently discussed item when not replying", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await world.send("/task");
    await world.press("New task");
    await world.send("Buy milk");
    await world.press("No deadline");
    await world.send("done");
    expect(world.lastText()).toBe("Completed: Buy milk.");
  });

  it("asks which item when there is no clear target, and changes nothing", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await world.send("move it to 4pm");
    expect(world.lastText()).toBe(
      "Which event or task do you mean? Reply to the message about it, or open it from /event or /tasks.",
    );
    await world.webhook(textUpdate(OWNER, "delete it", { replyTo: 1 }));
    expect(world.lastText()).toContain("I can't tell which event or task that message is about.");
  });

  it("keeps the normal confirmation rules: 'delete it' asks first", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await withDinner(world);
    await openDinner(world);
    await world.send("delete it");
    expect(world.lastText()).toContain("Delete event: Dinner");
    expect(ownerCalendar(world).live(PRIMARY.calendarId, "dinner")).not.toBeNull();
  });
});

/** Makes the next Google reads fail (the input's live read, then the operation's). */
function failNextReads(world: World, count: number) {
  for (let i = 0; i < count; i++) {
    ownerCalendar(world).inject({
      method: "get",
      mode: "error",
      error: { kind: "retryable", retryAfterMs: null },
    });
  }
}

describe("conflicts", () => {
  it("lets the user keep their change over a same-field Calendar edit", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await withDinner(world);
    const calendar = ownerCalendar(world);
    await openDinner(world);
    await world.press("Change time");
    await world.press("Tomorrow · Sat 26 Sep");
    // The change's first attempt fails, so it is still pending when Calendar changes.
    failNextReads(world, 2);
    await world.send("4pm");
    calendar.externalEdit(PRIMARY.calendarId, "dinner", { start: at(26, 17), end: at(26, 18) });
    world.clock.advance(60 * 60_000);
    await world.tick();
    expect(world.lastText()).toContain("Which should I keep?");
    await world.press("Use my change");
    expect(calendar.live(PRIMARY.calendarId, "dinner")?.fields.start).toEqual(at(26, 16));
  });

  it("keeps the Calendar version when chosen", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await withDinner(world);
    const calendar = ownerCalendar(world);
    await openDinner(world);
    await world.press("Rename");
    failNextReads(world, 2);
    await world.send("Dinner (mine)");
    calendar.externalEdit(PRIMARY.calendarId, "dinner", { summary: "Dinner (theirs)" });
    world.clock.advance(60 * 60_000);
    await world.tick();
    await world.press("Keep Calendar version");
    expect(world.lastText()).toBe("Kept the Calendar version of Dinner.");
    expect(calendar.live(PRIMARY.calendarId, "dinner")?.fields.summary).toBe("Dinner (theirs)");
  });
});

describe("sync health alerts", () => {
  it("alerts once after three failed checks, and once on recovery", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    const calendar = ownerCalendar(world);
    for (let i = 0; i < 5; i++) {
      calendar.inject({
        method: "list",
        mode: "error",
        error: { kind: "retryable", retryAfterMs: null },
      });
    }
    const outage = () =>
      world.texts().filter((t) => t.startsWith("Google Calendar sync has failed"));
    for (let i = 0; i < 5; i++) {
      world.clock.advance(60 * 60_000);
      await world.tick();
    }
    expect(outage()).toHaveLength(1);
    expect(outage()[0]).toContain("failed 3 times in a row (Google Calendar was unavailable)");

    world.clock.advance(60 * 60_000);
    await world.tick();
    world.clock.advance(60 * 60_000);
    await world.tick();
    expect(
      world.texts().filter((t) => t === "Google Calendar sync is working again."),
    ).toHaveLength(1);
  });
});
