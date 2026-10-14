import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { rows } from "../support/db";
import { OTHER_USER } from "../support/fakes";
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

function agendas(world: World) {
  return world.texts().filter((t) => t.startsWith("Here's your day."));
}

describe("agenda time and default reminder lead (D1)", () => {
  it("sends the agenda at the chosen hour, once per date", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await world.send("/settings");
    await world.press("Agenda time");
    await world.press("10am");
    expect(world.lastText()).toBe(
      "The daily agenda now arrives at 10am. A day that already had its agenda won't get a second one.",
    );
    await until(world, sgt(26, 8));
    expect(agendas(world)).toHaveLength(0);
    await until(world, sgt(26, 10));
    expect(agendas(world)).toHaveLength(1);
    // Moving the time earlier on a covered day sends nothing more.
    await world.send("/settings");
    await world.press("Agenda time");
    await world.press("6am");
    await until(world, sgt(26, 11));
    expect(agendas(world)).toHaveLength(1);
    await until(world, sgt(27, 6));
    expect(agendas(world)).toHaveLength(2);
  });

  it("uses the chosen lead for event reminders and the snooze shortcut follows the agenda", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    ownerCalendar(world).seed(PRIMARY.calendarId, "review", {
      summary: "Review",
      start: at(25, 15),
      end: at(25, 16),
    });
    await world.send("/settings");
    await world.press("Default reminder");
    await world.press("30 minutes before");
    await until(world, sgt(25, 14));
    expect(world.texts().some((t) => t.startsWith("In 1 hour: Review"))).toBe(false);
    await until(world, sgt(25, 14, 30));
    expect(world.lastText()).toBe("In 30 minutes: Review\nFri 25 Sep 2026, 3–4pm");

    await world.send("/settings");
    await world.press("Agenda time");
    await world.press("7am");
    await world.send("Pay rent");
    await world.send("/tasks");
    await world.press(/Pay rent/);
    await world.press("Snooze");
    expect(world.findButton("Tomorrow at 7am")).toBeTruthy();
  });

  it("uses the chosen lead for exact deadlines", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await world.send("/settings");
    await world.press("Default reminder");
    await world.press("2 hours before");
    await world.send("Send report by 5pm");
    await until(world, sgt(25, 15));
    expect(world.lastText()).toBe("Due in 2 hours: [Inbox] Send report\nDue Fri 25 Sep, 5pm");
  });

  it("refuses another user's setting buttons", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await world.send("/settings");
    await world.press("Agenda time");
    await world.press("10am", OTHER_USER);
    expect(world.answers().at(-1)).toBe("This button is no longer valid.");
    const [user] = await rows<{ agenda_hour: number }>(
      env.DB,
      "SELECT agenda_hour FROM users WHERE setup_step = 'done'",
    );
    expect(user?.agenda_hour).toBe(8);
  });
});
