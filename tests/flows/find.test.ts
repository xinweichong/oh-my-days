import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { SYNC_INTERVAL_MS } from "../../src/jobs/calendar-sync";
import { rows } from "../support/db";
import { OTHER_USER } from "../support/fakes";
import { inlineRows } from "../support/telegram";
import { ownerCalendar, PRIMARY, setUpOwner, World } from "../support/world";

// World time starts at Fri 25 Sep 2026, 09:00 in Singapore. Synthetic data only.
const at = (date: string, hour: number) => ({
  dateTime: `${date}T${String(hour).padStart(2, "0")}:00:00+08:00`,
  timeZone: "Asia/Singapore",
});

async function synced(world: World) {
  world.clock.advance(SYNC_INTERVAL_MS);
  await world.tick();
}

function labels(world: World): string[] {
  const call = [...world.telegram.calls].reverse().find((c) => "reply_markup" in c.params);
  return inlineRows(call)
    .flat()
    .map((b) => b.text);
}

describe("/find (C3)", () => {
  it("finds open tasks, upcoming and past one-off events, and recurring series", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    const calendar = ownerCalendar(world);
    calendar.seed(PRIMARY.calendarId, "sam", {
      summary: "Dinner with Sam",
      start: at("2026-09-30", 19),
      end: at("2026-09-30", 20),
    });
    calendar.seed(PRIMARY.calendarId, "team", {
      summary: "Team dinner",
      start: at("2026-09-20", 19),
      end: at("2026-09-20", 21),
    });
    calendar.seed(
      PRIMARY.calendarId,
      "weekly",
      {
        summary: "Family dinner",
        start: at("2026-09-27", 18),
        end: at("2026-09-27", 19),
      },
      { recurring: true },
    );
    calendar.seed(
      PRIMARY.calendarId,
      "weekly_20260927",
      {
        summary: "Family dinner",
        start: at("2026-09-27", 18),
        end: at("2026-09-27", 19),
      },
      { recurringEventId: "weekly" },
    );
    calendar.seed(
      PRIMARY.calendarId,
      "weekly_20261004",
      {
        summary: "Family dinner",
        start: at("2026-10-04", 18),
        end: at("2026-10-04", 19),
      },
      { recurringEventId: "weekly" },
    );
    await synced(world);
    await world.send("Book dinner place");
    await world.send("Buy milk");

    await world.send("/find DINNER");
    expect(world.lastText()).toBe('4 results for "DINNER".');
    expect(labels(world)).toEqual([
      "Task · [Inbox] Book dinner place",
      "Wed 30 Sep, 7pm · Dinner with Sam",
      "Sun 20 Sep, 7pm · Team dinner",
      "Repeats · next Sun 27 Sep, 6pm · Family dinner",
    ]);
    await world.press("Wed 30 Sep, 7pm · Dinner with Sam");
    expect(world.lastText()).toContain("Dinner with Sam\nWed 30 Sep 2026, 7–8pm");
    await world.send("/find dinner");
    await world.press("Task · [Inbox] Book dinner place");
    expect(world.findButton("Done")).toBeTruthy();
  });

  it("says when nothing matched, and when recurring events couldn't be searched", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await world.send("/find dentist");
    expect(world.lastText()).toBe('Nothing found for "dentist".');
    // Google can't be read for this calendar.
    ownerCalendar(world).inaccessible.add(PRIMARY.calendarId);
    await world.send("/find dentist");
    expect(world.lastText()).toBe(
      "Nothing found for \"dentist\".\nGoogle Calendar couldn't be reached, so recurring events weren't searched.",
    );
  });

  it("asks for words when sent bare, and treats % and _ literally", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await world.send("Give 100% effort");
    await world.send("Give 1000 thanks");
    await world.send("file_name fix");
    await world.send("filename fix");
    await world.send("/find");
    expect(world.lastText()).toBe("What should I look for? Send a few words.");
    await world.send("100%");
    expect(labels(world)).toEqual(["Task · [Inbox] Give 100% effort"]);
    await world.send("/find file_");
    expect(labels(world)).toEqual(["Task · [Inbox] file_name fix"]);
  });

  it("pages long results and caps them at 20", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    for (let i = 1; i <= 22; i++) await world.send(`Errand ${i}`);
    await world.send("/find errand");
    expect(world.lastText()).toBe('20 results for "errand".');
    expect(labels(world)).toHaveLength(9); // 8 results and More
    await world.press("More");
    expect(labels(world)).toContain("Previous");
  });

  it("never returns another user's tasks", async () => {
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
        "INSERT INTO task_lists (id, user_id, name, normalized_name, is_inbox, created_at, updated_at) VALUES ('ol', ?, 'Inbox', 'inbox', 1, ?, ?)",
      ).bind(other?.id, now, now),
      env.DB.prepare(
        "INSERT INTO tasks (id, user_id, list_id, title, due_kind, status, origin, created_at, updated_at) VALUES ('ot', ?, 'ol', 'Secret dinner plan', 'none', 'open', 'telegram', ?, ?)",
      ).bind(other?.id, now, now),
    ]);
    await world.send("/find dinner");
    expect(world.lastText()).toBe('Nothing found for "dinner".');
  });
});

describe("Change an event: Pick a date (C3)", () => {
  it("lists any day's events beyond the 14-day list", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    ownerCalendar(world).seed(PRIMARY.calendarId, "far", {
      summary: "Conference",
      start: at("2026-11-20", 9),
      end: at("2026-11-20", 17),
    });
    await world.send("/event");
    await world.press("Change an event");
    await world.press("Pick a date");
    await world.send("20 Nov");
    expect(world.lastText()).toBe("Events on Fri 20 Nov 2026:");
    await world.press("Fri 20 Nov, 9am · Conference");
    expect(world.lastText()).toContain("Conference\nFri 20 Nov 2026, 9am–5pm");
  });

  it("says when a day is empty, and asks which day when ambiguous", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await world.send("/event");
    await world.press("Change an event");
    await world.press("Pick a date");
    await world.send("fri");
    expect(world.lastText()).toBe("Which Friday?");
    await world.press("Fri 2 Oct");
    expect(world.lastText()).toBe("No events on Fri 2 Oct.");
  });
});
