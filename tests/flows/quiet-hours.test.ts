import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { quietWindow } from "../../src/domain/schedule";
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

async function quiet(world: World, label: string) {
  await world.send("/settings");
  await world.press("Quiet hours");
  await world.press(label);
}

describe("quietWindow", () => {
  const SG = "Asia/Singapore";
  const night = { start: 22, end: 7 };

  it("finds the window across midnight, active or just ended", () => {
    expect(quietWindow(sgt(25, 23), SG, night)).toEqual({
      from: sgt(25, 22),
      to: sgt(26, 7),
      active: true,
    });
    expect(quietWindow(sgt(26, 6, 59), SG, night)?.active).toBe(true);
    expect(quietWindow(sgt(26, 7), SG, night)).toEqual({
      from: sgt(25, 22),
      to: sgt(26, 7),
      active: false,
    });
    expect(quietWindow(sgt(26, 21, 59), SG, night)?.to).toBe(sgt(26, 7));
  });

  it("uses the local clock across a daylight-saving change", () => {
    // London falls back on Sun 25 Oct 2026: 22:00 BST is 21:00 UTC, 07:00 GMT is 07:00 UTC.
    const window = quietWindow(Date.UTC(2026, 9, 25, 3), "Europe/London", night);
    expect(window).toEqual({
      from: Date.UTC(2026, 9, 24, 21),
      to: Date.UTC(2026, 9, 25, 7),
      active: true,
    });
  });
});

describe("quiet hours (D5)", () => {
  it("holds reminders due overnight and sends one summary when quiet hours end", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await quiet(world, "10pm–7am");
    expect(world.lastText()).toBe(
      "Quiet hours: 10pm–7am. Reminders due then are sent together afterwards.",
    );
    await world.send("Call bank by 26 Sep 7:30am"); // reminder due 6:30am
    ownerCalendar(world).seed(PRIMARY.calendarId, "run", {
      summary: "Early run",
      start: at(26, 6),
      end: at(26, 7),
    }); // reminder due 5am, but it starts before quiet hours end
    await until(world, sgt(25, 21, 30));
    await until(world, sgt(26, 6, 30));
    const reminders = () =>
      world.texts().filter((t) => /^(Due in|In \d|Reminders|While quiet)/.test(t));
    expect(reminders()).toEqual([]);
    await until(world, sgt(26, 7));
    expect(world.lastText()).toBe(
      "While quiet hours were on:\n• [Inbox] Call bank · Due Sat 26 Sep, 7:30am",
    );
    expect(world.texts().some((t) => t.includes("Early run"))).toBe(false);
  });

  it("leaves reminders outside the window alone, and the agenda at its time", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await quiet(world, "10pm–8am");
    await world.send("/settings");
    await world.press("Agenda time");
    await world.press("7am");
    await world.send("Send report by 5pm");
    await until(world, sgt(25, 16));
    expect(world.lastText()).toBe("Due in 1 hour: [Inbox] Send report\nDue Fri 25 Sep, 5pm");
    await until(world, sgt(26, 7));
    expect(world.texts().some((t) => t.startsWith("Here's your day.\nSat 26 Sep"))).toBe(true);
  });

  it("is off by default and can be turned off", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await quiet(world, "11pm–7am");
    await quiet(world, "Off");
    expect(world.lastText()).toBe("Quiet hours off.");
    await world.send("Call bank by 26 Sep 1am");
    await until(world, sgt(26, 0));
    expect(world.lastText()).toBe("Due in 1 hour: [Inbox] Call bank\nDue Sat 26 Sep, 1am");
  });
});
