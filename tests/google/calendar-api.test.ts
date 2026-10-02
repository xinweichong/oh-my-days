import { describe, expect, it } from "vitest";
import { type AccessTokenSource, createGoogleCalendar } from "../../src/google/calendar-api";

interface Seen {
  method: string;
  url: URL;
  headers: Headers;
  body: unknown;
}

function api(
  responses: (Response | Error)[],
  tokens: AccessTokenSource = async () => ({ ok: true, token: "tok" }),
) {
  const seen: Seen[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    seen.push({
      method: init?.method ?? "GET",
      url: new URL(String(input)),
      headers: new Headers(init?.headers),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const next = responses.shift();
    if (!next || next instanceof Error) throw next ?? new Error("no response");
    return next;
  };
  return { calendar: createGoogleCalendar(tokens, fetchImpl), seen };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

const googleEvent = {
  id: "evt1",
  etag: '"e1"',
  status: "confirmed",
  summary: "Dinner",
  start: { dateTime: "2026-09-25T19:00:00+08:00", timeZone: "Asia/Singapore" },
  end: { dateTime: "2026-09-25T20:00:00+08:00", timeZone: "Asia/Singapore" },
};

describe("Google Calendar adapter", () => {
  it("creates events with a client-chosen ID and no attendee notifications", async () => {
    const { calendar, seen } = api([json(200, googleEvent)]);
    const result = await calendar.insertEvent("cal@x", "evt1", {
      summary: "Dinner",
      start: googleEvent.start,
      end: googleEvent.end,
    });
    expect(result).toMatchObject({ ok: true, value: { id: "evt1", etag: '"e1"' } });
    expect(seen[0]?.url.pathname).toBe("/calendar/v3/calendars/cal%40x/events");
    expect(seen[0]?.url.searchParams.get("sendUpdates")).toBe("none");
    expect(seen[0]?.body).toMatchObject({ id: "evt1", summary: "Dinner" });
    expect(seen[0]?.headers.get("authorization")).toBe("Bearer tok");
  });

  it("sends If-Match for conditional edits and maps 412 to a conflict", async () => {
    const { calendar, seen } = api([json(412, { error: {} })]);
    const result = await calendar.patchEvent("c", "evt1", { summary: "X" }, '"e1"');
    expect(seen[0]?.headers.get("if-match")).toBe('"e1"');
    expect(result).toEqual({ ok: false, error: { kind: "conflict" } });
  });

  it("refreshes the token once when Google rejects it", async () => {
    const forced: boolean[] = [];
    const tokens: AccessTokenSource = async (force) => {
      forced.push(force);
      return { ok: true, token: force ? "fresh" : "stale" };
    };
    const { calendar, seen } = api([json(401, {}), json(200, googleEvent)], tokens);
    expect((await calendar.getEvent("c", "evt1")).ok).toBe(true);
    expect(forced).toEqual([false, true]);
    expect(seen[1]?.headers.get("authorization")).toBe("Bearer fresh");
  });

  it("reports reconnection is needed when no token can be obtained", async () => {
    const { calendar, seen } = api([], async () => ({ ok: false, reason: "auth_required" }));
    expect(await calendar.getEvent("c", "e")).toEqual({
      ok: false,
      error: { kind: "auth_required" },
    });
    expect(seen).toHaveLength(0);
  });

  it("separates rate limits from permission errors", async () => {
    const limited = api([
      json(403, { error: { errors: [{ reason: "userRateLimitExceeded" }] } }),
    ]).calendar;
    expect(await limited.getEvent("c", "e")).toMatchObject({
      ok: false,
      error: { kind: "retryable" },
    });
    const denied = api([json(403, { error: { errors: [{ reason: "forbidden" }] } })]).calendar;
    expect(await denied.getEvent("c", "e")).toEqual({ ok: false, error: { kind: "forbidden" } });
    const busy = api([json(429, {}, { "retry-after": "7" })]).calendar;
    expect(await busy.getEvent("c", "e")).toEqual({
      ok: false,
      error: { kind: "retryable", retryAfterMs: 7000 },
    });
  });

  it("treats a failed write as an unknown outcome but a failed read as retryable", async () => {
    const write = api([new TypeError("network")]).calendar;
    expect(await write.deleteEvent("c", "e", '"1"')).toEqual({
      ok: false,
      error: { kind: "outcome_unknown" },
    });
    const read = api([new TypeError("network")]).calendar;
    expect(await read.getEvent("c", "e")).toMatchObject({
      ok: false,
      error: { kind: "retryable" },
    });
  });

  it("lists every page of calendars and skips deleted entries", async () => {
    const { calendar, seen } = api([
      json(200, {
        items: [
          { id: "primary@x", summary: "Me", accessRole: "owner", primary: true },
          { id: "gone@x", summary: "Gone", accessRole: "owner", deleted: true },
        ],
        nextPageToken: "p2",
      }),
      json(200, {
        items: [
          { id: "team@x", summary: "Team", summaryOverride: "My team", accessRole: "reader" },
        ],
      }),
    ]);
    const result = await calendar.listCalendars();
    expect(result).toEqual({
      ok: true,
      value: [
        { calendarId: "primary@x", summary: "Me", accessRole: "owner", primary: true },
        { calendarId: "team@x", summary: "My team", accessRole: "reader", primary: false },
      ],
    });
    expect(seen[1]?.url.searchParams.get("pageToken")).toBe("p2");
  });
});
