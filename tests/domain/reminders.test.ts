import { describe, expect, it } from "vitest";
import {
  checkRule,
  decodeRule,
  encodeRule,
  mergeRules,
  parseReminders,
  type ReminderAnchor,
  type ReminderRule,
  reminderTimes,
  resolveEntries,
  ruleKeyPart,
} from "../../src/domain/reminders";

const SG = "Asia/Singapore";
const today = "2026-09-25"; // a Friday
const sgt = (day: number, hour: number, minute = 0) => Date.UTC(2026, 8, day, hour - 8, minute);
const now = sgt(25, 9);
const dinner: ReminderAnchor = { kind: "instant", at: sgt(30, 19) }; // Wed
const rentDue: ReminderAnchor = { kind: "date", date: "2026-09-28" };
const context = { now, timeZone: SG, agendaHour: 8 };

function rules(input: string, anchor: ReminderAnchor = dinner): ReminderRule[] {
  const parsed = parseReminders(input, today);
  if (parsed.kind !== "entries") throw new Error(`not entries: ${JSON.stringify(parsed)}`);
  const resolved = resolveEntries(parsed.entries, anchor, context);
  expect(resolved.problems).toEqual([]);
  return resolved.rules;
}

describe("typed reminders", () => {
  it("reads lead times in several spellings", () => {
    expect(rules("30m, 2 hours before and 1h30m")).toEqual([
      { kind: "before", minutes: 30 },
      { kind: "before", minutes: 120 },
      { kind: "before", minutes: 90 },
    ]);
    expect(rules("half an hour, a day before, 3 days")).toEqual([
      { kind: "before", minutes: 30 },
      { kind: "before", minutes: 1440 },
      { kind: "before", minutes: 4320 },
    ]);
    expect(rules("remind me 15 minutes before")).toEqual([{ kind: "before", minutes: 15 }]);
    expect(rules("at the time")).toEqual([{ kind: "before", minutes: 0 }]);
  });

  it("reads a time on a day relative to the item", () => {
    expect(rules("1 day before 6pm; the day before at 9am; 9am on the day")).toEqual([
      { kind: "day", days: 1, time: "18:00" },
      { kind: "day", days: 1, time: "09:00" },
      { kind: "day", days: 0, time: "09:00" },
    ]);
    expect(rules("2 days before 9:30am, 1d 7am, noon")).toEqual([
      { kind: "day", days: 2, time: "09:30" },
      { kind: "day", days: 1, time: "07:00" },
      { kind: "day", days: 0, time: "12:00" },
    ]);
  });

  it("reads a fixed date and time in the user's zone", () => {
    expect(rules("tomorrow 6pm, Sat 8am")).toEqual([
      { kind: "at", at: sgt(26, 18) },
      { kind: "at", at: sgt(26, 8) },
    ]);
  });

  it("recognizes none and default, and refuses what it can't read", () => {
    expect(parseReminders("no reminders", today)).toEqual({ kind: "none" });
    expect(parseReminders("Default", today)).toEqual({ kind: "default" });
    expect(parseReminders("1h, soonish", today)).toEqual({
      kind: "error",
      part: "soonish",
      reason: "unrecognized",
    });
    expect(parseReminders("at 6", today)).toMatchObject({ kind: "error", reason: "ambiguous" });
    expect(parseReminders("Thursday", today)).toMatchObject({
      kind: "error",
      reason: "needs_time",
    });
    expect(parseReminders("the day before", today)).toMatchObject({ reason: "needs_time" });
  });

  it("puts whole-day leads on a date-only deadline at the agenda hour, and refuses hours", () => {
    expect(rules("1 day before, 2 days before 6pm", rentDue)).toEqual([
      { kind: "day", days: 1, time: "08:00" },
      { kind: "day", days: 2, time: "18:00" },
    ]);
    const parsed = parseReminders("2h", today);
    if (parsed.kind !== "entries") throw new Error("expected entries");
    expect(resolveEntries(parsed.entries, rentDue, context).problems).toEqual([
      { source: "2h", problem: "needs_time" },
    ]);
  });

  it("reports times that have passed or fall after the item", () => {
    const soon: ReminderAnchor = { kind: "instant", at: sgt(25, 10) };
    const parsed = parseReminders("1 day before, 30m, 11am, 3 weeks", today);
    if (parsed.kind !== "entries") throw new Error("expected entries");
    expect(resolveEntries(parsed.entries, soon, context)).toEqual({
      rules: [{ kind: "before", minutes: 30 }],
      problems: [
        { source: "1 day before", problem: "passed" },
        { source: "11am", problem: "after" },
        { source: "3 weeks", problem: "too_early" },
      ],
    });
  });
});

describe("reminder times", () => {
  it("fires each rule once, earliest first, within the item's day for date-only deadlines", () => {
    const times = reminderTimes(
      [
        { kind: "day", days: 0, time: "18:00" },
        { kind: "day", days: 1, time: "09:00" },
        { kind: "at", at: sgt(27, 12) },
      ],
      rentDue,
      SG,
    );
    expect(times.map((t) => t.at)).toEqual([sgt(27, 9), sgt(27, 12), sgt(28, 18)]);
    // A lead time needs an exact time, so it never fires for a date-only deadline.
    expect(reminderTimes([{ kind: "before", minutes: 60 }], rentDue, SG)).toEqual([]);
  });

  it("follows the user's zone across a daylight-saving change", () => {
    // London leaves BST on Sun 25 Oct 2026: 9am the day before is BST, the event is GMT.
    const event: ReminderAnchor = { kind: "instant", at: Date.UTC(2026, 9, 26, 9) };
    const [only] = reminderTimes([{ kind: "day", days: 1, time: "09:00" }], event, "Europe/London");
    expect(only?.at).toBe(Date.UTC(2026, 9, 25, 9));
    const [lead] = reminderTimes([{ kind: "before", minutes: 1440 }], event, "Europe/London");
    expect(lead?.at).toBe(Date.UTC(2026, 9, 25, 9));
  });

  it("refuses a rule once its time has passed", () => {
    expect(checkRule({ kind: "before", minutes: 1440 }, dinner, context)).toBeNull();
    expect(checkRule({ kind: "before", minutes: 6 * 1440 }, dinner, context)).toBe("passed");
    expect(checkRule({ kind: "before", minutes: 60 }, rentDue, context)).toBe("needs_time");
  });
});

describe("rule codes", () => {
  it("round-trips, and keeps bare minutes in keys for lead times", () => {
    const all: ReminderRule[] = [
      { kind: "before", minutes: 60 },
      { kind: "day", days: 1, time: "18:00" },
      { kind: "at", at: sgt(26, 8) },
    ];
    for (const rule of all) expect(decodeRule(encodeRule(rule))).toEqual(rule);
    expect(all.map(ruleKeyPart)).toEqual(["60", "d1@18:00", `a${sgt(26, 8)}`]);
    expect(decodeRule("b99999")).toBeNull();
    expect(decodeRule("d9@18:00")).toBeNull();
    expect(decodeRule("d1@25:00")).toBeNull();
  });

  it("merges without duplicates and caps the set at five", () => {
    const lead = (minutes: number): ReminderRule => ({ kind: "before", minutes });
    const merged = mergeRules([lead(10), lead(60)], [lead(60), ...[1, 2, 3, 4].map(lead)]);
    expect(merged.rules.map(encodeRule)).toEqual(["b10", "b60", "b1", "b2", "b3"]);
    expect(merged.overflow).toBe(1);
  });
});
