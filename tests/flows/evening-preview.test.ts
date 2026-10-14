import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { ownerCalendar, PRIMARY, setUpOwner, World } from "../support/world";

// World time starts at Fri 25 Sep 2026, 09:00 in Singapore.
const sgt = (day: number, hour: number, minute = 0) => Date.UTC(2026, 8, day, hour - 8, minute);
const at = (day: number, hour: number) => ({
  dateTime: `2026-09-${day}T${String(hour).padStart(2, "0")}:00:00+08:00`,
  timeZone: "Asia/Singapore",
});

async function until(world: World, instant: number) {
  world.clock.current = instant;
  await world.tick();
}

function previews(world: World) {
  return world.texts().filter((t) => t.startsWith("Tomorrow\n"));
}

async function turnOn(world: World, label: string) {
  await world.send("/settings");
  await world.press("Evening preview");
  await world.press(label);
}

describe("evening preview of tomorrow (D2)", () => {
  it("is off by default", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await until(world, sgt(25, 21));
    await until(world, sgt(25, 23));
    expect(previews(world)).toEqual([]);
  });

  it("sends tomorrow once at the chosen hour, like the agenda", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    ownerCalendar(world).seed(PRIMARY.calendarId, "brunch", {
      summary: "Brunch",
      start: at(26, 11),
      end: at(26, 12),
    });
    await world.send("Pay rent by today"); // overdue tomorrow, but previews show only that day
    await world.send("Submit expenses by tomorrow");
    await turnOn(world, "9pm");
    expect(world.lastText()).toBe("I'll send a preview of tomorrow at 9pm.");
    await until(world, sgt(25, 20, 59));
    expect(previews(world)).toEqual([]);
    await until(world, sgt(25, 21));
    expect(previews(world)).toEqual([
      [
        "Tomorrow",
        "Sat 26 Sep 2026",
        "",
        "Events",
        "• 11am–12pm Brunch",
        "",
        "Due",
        "• [Inbox] Submit expenses",
      ].join("\n"),
    ]);
    await until(world, sgt(25, 23));
    expect(previews(world)).toHaveLength(1);
    await until(world, sgt(26, 21));
    expect(previews(world)).toHaveLength(2);
  });

  it("is not sent late after midnight, and stops when turned off", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await turnOn(world, "10pm");
    await until(world, sgt(26, 0, 30)); // the scheduler missed Friday evening
    expect(previews(world)).toEqual([]);
    await turnOn(world, "Off");
    expect(world.lastText()).toBe("Evening preview off.");
    await until(world, sgt(26, 22));
    expect(previews(world)).toEqual([]);
  });
});
