import { describe, expect, it } from "vitest";
import { toDisplay, toEvent } from "../../src/google/calendar-api";

// Synthetic provider payloads.
const base = {
  id: "e1",
  etag: '"1"',
  status: "confirmed",
  summary: "Planning",
  start: { dateTime: "2026-10-09T10:00:00+08:00", timeZone: "Asia/Singapore" },
  end: { dateTime: "2026-10-09T11:00:00+08:00", timeZone: "Asia/Singapore" },
};

describe("event display details (C2)", () => {
  it("reads location, the Meet link, and the Calendar link", () => {
    expect(
      toDisplay({
        location: "  Room 4,\n Level 2 ",
        hangoutLink: "https://meet.google.com/abc-defg-hij",
        htmlLink: "https://www.google.com/calendar/event?eid=xyz",
      }),
    ).toEqual({
      location: "Room 4, Level 2",
      callUrl: "https://meet.google.com/abc-defg-hij",
      htmlLink: "https://www.google.com/calendar/event?eid=xyz",
    });
  });

  it("takes another provider's video entry point", () => {
    const display = toDisplay({
      conferenceData: {
        entryPoints: [
          { entryPointType: "phone", uri: "tel:+1-555-0100" },
          { entryPointType: "video", uri: "https://example-video.test/j/123" },
        ],
      },
    });
    expect(display.callUrl).toBe("https://example-video.test/j/123");
  });

  it("drops links that aren't https or point elsewhere, and caps long text", () => {
    const display = toDisplay({
      location: "x".repeat(500),
      hangoutLink: "javascript:alert(1)",
      htmlLink: "https://calendar.evil.test/event",
    });
    expect(display.location).toHaveLength(200);
    expect(display.callUrl).toBeNull();
    expect(display.htmlLink).toBeNull();
    expect(toDisplay({ hangoutLink: "http://meet.google.com/x" }).callUrl).toBeNull();
  });

  it("keeps display details out of the editable fields", () => {
    const event = toEvent("cal", { ...base, location: "Room 4" });
    expect(event?.display?.location).toBe("Room 4");
    expect(Object.keys(event?.fields ?? {})).toEqual(["summary", "start", "end"]);
  });
});
