import { describe, expect, it } from "vitest";
import { type Capture, type CaptureContext, capture } from "../../src/domain/capture";

// Fri 9 Oct 2026. Synthetic names only.
const ctx: CaptureContext = {
  today: "2026-10-09",
  calendars: [
    { id: "cal-personal", name: "Personal" },
    { id: "cal-team", name: "Team Events" },
  ],
  lists: [
    { id: "list-inbox", name: "Inbox" },
    { id: "list-work", name: "Work" },
    { id: "list-shop", name: "Shopping list" },
  ],
};

const event = (
  title: string,
  date: string,
  start: string | null,
  length: unknown = null,
  calendarId: string | null = null,
) => ({ kind: "create", draft: { kind: "event", title, date, start, length, calendarId } });

const task = (title: string, due: unknown, listId: string | null = null) => ({
  kind: "create",
  draft: { kind: "task", title, due, listId },
});

const none = { kind: "none" };
const on = (date: string) => ({ kind: "date", date });
const at = (date: string, time: string) => ({ kind: "datetime", date, time });

describe("capture: events", () => {
  it.each<[string, unknown]>([
    ["Dinner Thu 7pm", event("Dinner", "2026-10-15", "19:00")],
    ["Dinner Thursday at 7pm", event("Dinner", "2026-10-15", "19:00")],
    ["Dinner next Fri 7pm", event("Dinner", "2026-10-16", "19:00")],
    ["Call Alex tomorrow at 3pm", event("Call Alex", "2026-10-10", "15:00")],
    ["Meeting 3pm tomorrow", event("Meeting", "2026-10-10", "15:00")],
    ["Standup 09:00", event("Standup", "2026-10-09", "09:00")],
    ["Standup 21:00", event("Standup", "2026-10-09", "21:00")],
    ["Gym 6pm", event("Gym", "2026-10-09", "18:00")],
    ["Dinner Sat 7-9pm", event("Dinner", "2026-10-10", "19:00", { endTime: "21:00" })],
    ["Dinner sat at 7-9pm", event("Dinner", "2026-10-10", "19:00", { endTime: "21:00" })],
    ["Movie 9 Oct 19:00–21:30", event("Movie", "2026-10-09", "19:00", { endTime: "21:30" })],
    [
      "Lunch Monday at noon for two hours on Personal",
      event("Lunch", "2026-10-12", "12:00", { minutes: 120 }, "cal-personal"),
    ],
    ["Lunch Monday for 90m at noon", event("Lunch", "2026-10-12", "12:00", { minutes: 90 })],
    ["Retro mon 4pm until 5:30pm", event("Retro", "2026-10-12", "16:00", { endTime: "17:30" })],
    ["Offsite on team events mon 10am", event("Offsite", "2026-10-12", "10:00", null, "cal-team")],
    ["Add dinner Mon 7pm", event("Dinner", "2026-10-12", "19:00")],
    ["Party in 2 weeks 8pm", event("Party", "2026-10-23", "20:00")],
  ])("%s", (input, expected) => {
    expect(capture(input, ctx)).toEqual(expected);
  });
});

describe("capture: tasks", () => {
  it.each<[string, unknown]>([
    ["Buy milk", task("Buy milk", none)],
    ["Remind me to buy milk tomorrow", task("Buy milk", on("2026-10-10"))],
    ["remind me to call the bank at 3pm", task("Call the bank", at("2026-10-09", "15:00"))],
    ["Pay rent by 1 Nov", task("Pay rent", on("2026-11-01"))],
    ["Submit report due Mon 5pm", task("Submit report", at("2026-10-12", "17:00"))],
    ["Submit report by 5pm", task("Submit report", at("2026-10-09", "17:00"))],
    ["task: renew passport", task("Renew passport", none)],
    ["todo book flights next week", task("Book flights", on("2026-10-12"))],
    [
      "Add submit expenses to Work, due Monday",
      task("Submit expenses", on("2026-10-12"), "list-work"),
    ],
    ["Eggs to shopping list", task("Eggs", none, "list-shop")],
    ["task file taxes in work eom", task("File taxes", on("2026-10-31"), "list-work")],
  ])("%s", (input, expected) => {
    expect(capture(input, ctx)).toEqual(expected);
  });

  it("keeps unmatched attribute phrases in the title", () => {
    expect(capture("Send report to Alex", ctx)).toEqual(task("Send report to Alex", none));
    expect(capture("Dinner on the roof Mon 7pm", ctx)).toEqual(
      event("Dinner on the roof", "2026-10-12", "19:00"),
    );
    // A list phrase on an event, or a calendar phrase on a task, stays in the title.
    expect(capture("Dinner to Work Mon 7pm", ctx)).toEqual(
      event("Dinner to Work", "2026-10-12", "19:00"),
    );
    expect(capture("task review on Personal", ctx)).toEqual(task("Review on Personal", none));
  });

  it("does not read numbers or ordinary words as times or days", () => {
    expect(capture("Buy 3 apples", ctx)).toEqual(task("Buy 3 apples", none));
    expect(capture("Buy sun cream", ctx)).toEqual(task("Buy sun cream", none));
    expect(capture("Lunch at Joe's", ctx)).toEqual(task("Lunch at Joe's", none));
    expect(capture("I may go", ctx)).toEqual(task("I may go", none));
  });

  it("keeps Unicode titles intact", () => {
    expect(capture("Café with Zoë Mon 7pm", ctx)).toEqual(
      event("Café with Zoë", "2026-10-12", "19:00"),
    );
    expect(capture("买牛奶", ctx)).toEqual(task("买牛奶", none));
    expect(capture("Lunch 🍜 mon 1pm", ctx)).toEqual(event("Lunch 🍜", "2026-10-12", "13:00"));
  });
});

describe("capture: questions", () => {
  it("asks task or all-day event for a date with no time or task language", () => {
    expect(capture("Dentist Monday", ctx)).toEqual({
      kind: "choose",
      options: [
        { kind: "task", title: "Dentist", due: on("2026-10-12"), listId: null },
        {
          kind: "event",
          title: "Dentist",
          date: "2026-10-12",
          start: null,
          length: null,
          calendarId: null,
        },
      ],
    });
  });

  it("asks which Friday on a Friday", () => {
    const result = capture("Dinner fri 7pm", ctx) as Extract<Capture, { kind: "choose" }>;
    expect(result.kind).toBe("choose");
    expect(result.options.map((o) => o.kind === "event" && o.date)).toEqual([
      "2026-10-09",
      "2026-10-16",
    ]);
  });

  it("asks am or pm for 'at 3' and unpadded clock times", () => {
    const result = capture("Call mum tomorrow at 3", ctx) as Extract<Capture, { kind: "choose" }>;
    expect(result.options.map((o) => o.kind === "event" && o.start)).toEqual(["03:00", "15:00"]);
    const clock = capture("Call mum 3:30", ctx) as Extract<Capture, { kind: "choose" }>;
    expect(clock.options.map((o) => o.kind === "event" && o.start)).toEqual(["03:30", "15:30"]);
  });

  it("refuses a date or time with nothing to call it", () => {
    expect(capture("tomorrow 3pm", ctx)).toEqual({ kind: "no_title" });
    expect(capture("remind me to tomorrow", ctx)).toEqual({ kind: "no_title" });
  });
});

describe("capture: one instruction per message", () => {
  it.each([
    "Lunch Friday at noon, submit expenses Monday, and buy milk",
    "Call mum tomorrow and dentist Monday",
    "Gym 7am; dinner 8pm",
    "Dinner Mon 7pm\nLunch Tue noon",
  ])("refuses several requests: %s", (input) => {
    expect(capture(input, ctx)).toEqual({ kind: "multiple" });
  });

  it("does not treat two dates without a separator as an edit", () => {
    expect(capture("Move dentist from Mon to Tue", ctx)).toEqual({
      kind: "unclear",
      title: "Move dentist from Mon to Tue",
    });
  });
});

describe("capture: unclear input", () => {
  it.each([
    ["???", "???"],
    ["🎉🎉", "🎉🎉"],
    ["Notes from the call\nAgenda items follow", "Notes from the call"],
    ["Run 5k for 30 min", "Run 5k for 30 min"],
    ["task stretch at 7-8am", "task stretch at 7-8am"],
  ])("%s", (input, title) => {
    expect(capture(input, ctx)).toEqual({ kind: "unclear", title });
  });

  it("offers over-long text with a clipped title", () => {
    const long = `Read ${"a".repeat(250)}`;
    const result = capture(long, ctx);
    expect(result.kind).toBe("unclear");
    expect(result.kind === "unclear" && result.title.length).toBe(200);
  });
});
