import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { agendaKind } from "../../src/domain/schedule";
import { rows } from "../support/db";
import { ownerCalendar, PRIMARY, setUpOwner, World } from "../support/world";

// World time starts at Fri 25 Sep 2026, 09:00 in Singapore; setup finishes then.
const sgt = (day: number, hour: number, minute = 0) => Date.UTC(2026, 8, day, hour - 8, minute);
const at = (day: number, hour: number) => ({
  dateTime: `2026-09-${day}T${String(hour).padStart(2, "0")}:00:00+08:00`,
  timeZone: "Asia/Singapore",
});

function agendaTexts(world: World): string[] {
  return world
    .texts()
    .filter((t) => t.startsWith("Here's your day.") || t.startsWith("Catch-up: today so far."));
}

async function until(world: World, instant: number) {
  world.clock.current = instant;
  await world.tick();
}

async function coveredDates(): Promise<string[]> {
  const found = await rows<{ local_date: string }>(
    env.DB,
    "SELECT local_date FROM agenda_runs ORDER BY local_date",
  );
  return found.map((r) => r.local_date);
}

describe("agendaKind", () => {
  const SG = "Asia/Singapore";
  it.each([
    [sgt(26, 7, 59), null],
    [sgt(26, 8), "full"],
    [sgt(26, 11, 59), "full"],
    [sgt(26, 12), "catch_up"],
    [sgt(26, 19, 59), "catch_up"],
    [sgt(26, 20), "skip"],
    [sgt(26, 23, 59), "skip"],
  ])("%s", (now, kind) => {
    expect(agendaKind(now, SG)?.kind ?? null).toBe(kind);
  });

  it("follows the local clock across a daylight-saving change", () => {
    // Sun 25 Oct 2026, London falls back at 02:00 BST; 11:30 UTC is 11:30 GMT.
    expect(agendaKind(Date.UTC(2026, 9, 25, 11, 30), "Europe/London")?.kind).toBe("full");
    expect(agendaKind(Date.UTC(2026, 9, 25, 12, 0), "Europe/London")?.kind).toBe("catch_up");
    // Sat 24 Oct (BST): 11:30 UTC is 12:30 local.
    expect(agendaKind(Date.UTC(2026, 9, 24, 11, 30), "Europe/London")?.kind).toBe("catch_up");
  });
});

describe("late daily agenda", () => {
  it("sends no agenda on the setup day when setup finishes after 8am", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await until(world, sgt(25, 12));
    expect(agendaTexts(world)).toEqual([]);
    expect(await coveredDates()).toEqual(["2026-09-25"]);
  });

  it("sends the full agenda when the scheduler is back before noon", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await until(world, sgt(26, 11, 30));
    expect(agendaTexts(world).at(-1)).toMatch(/^Here's your day\./);
  });

  it("after noon sends a catch-up with only the rest of the day", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    const calendar = ownerCalendar(world);
    calendar.seed(PRIMARY.calendarId, "standup", {
      summary: "Standup",
      start: at(26, 9),
      end: at(26, 10),
    });
    calendar.seed(PRIMARY.calendarId, "dinner", {
      summary: "Dinner",
      start: at(26, 19),
      end: at(26, 20),
    });
    await world.send("Pay rent by 26 Sep");
    // The scheduler was down all morning.
    await until(world, sgt(26, 13));
    const [agenda] = agendaTexts(world);
    expect(agenda).toBe(
      [
        "Catch-up: today so far.",
        "Sat 26 Sep 2026",
        "",
        "Events",
        "• 7–8pm Dinner",
        "",
        "Due today",
        "• [Inbox] Pay rent",
      ].join("\n"),
    );
    await until(world, sgt(26, 15));
    expect(agendaTexts(world)).toHaveLength(1);
  });

  it("says when no events remain", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    ownerCalendar(world).seed(PRIMARY.calendarId, "standup", {
      summary: "Standup",
      start: at(26, 9),
      end: at(26, 10),
    });
    await until(world, sgt(26, 14));
    expect(agendaTexts(world).at(-1)).toContain("No more events today.");
  });

  it("after 8pm skips the agenda and counts the date as covered", async () => {
    const world = new World(env.DB);
    await setUpOwner(world);
    await until(world, sgt(26, 20, 30));
    expect(agendaTexts(world)).toEqual([]);
    expect(await coveredDates()).toEqual(["2026-09-25", "2026-09-26"]);
    await until(world, sgt(27, 8));
    expect(agendaTexts(world)).toHaveLength(1);
    expect(agendaTexts(world)[0]).toMatch(/^Here's your day\.\nSun 27 Sep 2026/);
  });
});
