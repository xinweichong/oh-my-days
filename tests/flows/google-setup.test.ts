import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { connectionDeps } from "../../src/app";
import { CONNECT_LINK_TTL_MS, connectedCalendar } from "../../src/application/google-connection";
import { TASK_CALENDAR_NAME } from "../../src/application/setup";
import { count, rows } from "../support/db";
import { OTHER_USER, OWNER } from "../support/fakes";
import { userIdFor } from "../support/telegram";
import { OWNER_ACCOUNT, World } from "../support/world";

const TEAM = {
  calendarId: "team@group.test",
  summary: "Team",
  accessRole: "reader" as const,
  primary: false,
};
const PERSONAL = {
  calendarId: "personal@group.test",
  summary: "Personal",
  accessRole: "owner" as const,
  primary: false,
};
const PRIMARY = {
  calendarId: "owner@example.com",
  summary: "owner@example.com",
  accessRole: "owner" as const,
  primary: true,
};

async function connected(world: World): Promise<string> {
  world.google.account(OWNER_ACCOUNT.subject, OWNER_ACCOUNT.email, [PRIMARY, PERSONAL, TEAM]);
  await world.send("/start");
  const url = await world.press("Connect Google Calendar");
  if (!url) throw new Error("expected a link");
  const { page } = await world.authorize(url, OWNER_ACCOUNT);
  expect(page).toContain("✓ Google Calendar connected");
  return userIdFor(env.DB, OWNER);
}

async function finishSetup(world: World): Promise<string> {
  const userId = await connected(world);
  await world.press("Done");
  await world.press("owner@example.com");
  await world.press("Create calendar");
  await world.press("Keep Asia/Singapore");
  return userId;
}

describe("Google connection and setup", () => {
  it("connects, then guides calendars, default, task calendar, and timezone", async () => {
    const world = new World(env.DB);
    await world.send("/start");
    expect(world.lastText()).toContain("Connect Google Calendar to get started");

    const userId = await connected(world);
    expect(world.texts()).toContain("Google Calendar connected: owner@example.com.");
    expect(world.findButton("✓ owner@example.com")).toBeTruthy(); // primary preselected
    expect(world.findButton("Team (view only)")).toBeTruthy();

    await world.press("Team (view only)");
    const edit = world.telegram.calls.at(-1);
    expect(edit?.method).toBe("editMessageText");
    expect(world.findButton("✓ Team (view only)")).toBeTruthy();

    await world.press("Done");
    expect(world.lastText()).toContain("Choose the default calendar");
    expect(() => world.findButton(/^Team/)).not.toThrow(); // still on the older picker…
    const defaultChoices = world.telegram.calls.at(-1);
    const labels =
      defaultChoices && "reply_markup" in defaultChoices.params
        ? defaultChoices.params.reply_markup?.inline_keyboard.flat().map((b) => b.text)
        : [];
    expect(labels).toEqual(["owner@example.com", "Personal", "Create a new calendar"]); // …but read-only is not offered

    await world.press("owner@example.com");
    expect(world.texts()).toContain(
      "New events go to owner@example.com unless you name another calendar.",
    );
    expect(world.lastText()).toContain(`"${TASK_CALENDAR_NAME}"`);

    await world.press("Create calendar");
    expect(world.texts()).toContain(`Created ${TASK_CALENDAR_NAME} for task deadlines.`);
    expect(world.lastText()).toContain("Your timezone is Asia/Singapore");

    await world.press("Keep Asia/Singapore");
    expect(world.lastText()).toBe(
      [
        "Setup complete.",
        "",
        "Calendars: owner@example.com, Team",
        "Default for new events: owner@example.com",
        `Task deadlines: ${TASK_CALENDAR_NAME}`,
        "Timezone: Asia/Singapore",
        "",
        "Adding events and tasks arrives in a later update. Use /settings to change these.",
      ].join("\n"),
    );

    const [user] = await rows<{
      setup_step: string;
      default_calendar_id: string;
      task_calendar_id: string;
    }>(
      env.DB,
      "SELECT setup_step, default_calendar_id, task_calendar_id FROM users WHERE id = ?",
      userId,
    );
    expect(user?.setup_step).toBe("done");
    expect(user?.default_calendar_id).toBe("owner@example.com");
    expect(user?.task_calendar_id).toMatch(/@group\.calendar\.test$/);
  });

  it("stores Google tokens only in encrypted form", async () => {
    const world = new World(env.DB);
    await connected(world);
    const [row] = await rows<{ refresh_token_enc: string; access_token_enc: string }>(
      env.DB,
      "SELECT refresh_token_enc, access_token_enc FROM google_connections",
    );
    expect(row?.refresh_token_enc).toMatch(/^v1\./);
    expect(row?.refresh_token_enc).not.toContain("refresh-");
    expect(row?.access_token_enc).not.toContain("access-");
  });

  it("does not consume the link when the page is merely opened or refreshed", async () => {
    const world = new World(env.DB);
    await world.send("/start");
    const url = new URL((await world.press("Connect Google Calendar")) ?? "");
    for (let i = 0; i < 3; i++) {
      expect(await (await world.request(url.pathname + url.search)).text()).toContain(
        'action="/oauth/start"',
      );
    }
  });

  it("starts authorization only once per link", async () => {
    const world = new World(env.DB);
    await world.send("/start");
    const url = new URL((await world.press("Connect Google Calendar")) ?? "");
    const token = url.searchParams.get("t") ?? "";
    const post = () =>
      world.request("/oauth/start", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ t: token }).toString(),
      });
    expect((await post()).status).toBe(303);
    const replay = await post();
    expect(replay.status).toBe(200);
    expect(await replay.text()).toContain("This connection link is no longer valid");
  });

  it("rejects expired links", async () => {
    const world = new World(env.DB);
    await world.send("/start");
    const url = new URL((await world.press("Connect Google Calendar")) ?? "");
    world.clock.advance(CONNECT_LINK_TTL_MS + 1);
    expect(await (await world.request(url.pathname + url.search)).text()).toContain(
      "no longer valid",
    );
  });

  it("shows a refreshed callback's recorded outcome without exchanging the code again", async () => {
    const world = new World(env.DB);
    world.google.account(OWNER_ACCOUNT.subject, OWNER_ACCOUNT.email);
    await world.send("/start");
    const url = (await world.press("Connect Google Calendar")) ?? "";
    const { callbackPath } = await world.authorize(url, OWNER_ACCOUNT);

    const again = await world.request(callbackPath);
    expect(await again.text()).toContain("✓ Google Calendar connected");
    expect(world.google.exchangeCalls).toBe(1);
    expect(again.headers.get("cache-control")).toBe("no-store");
    expect(again.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("decides an interrupted callback from the persisted connection, never by re-exchanging", async () => {
    const world = new World(env.DB);
    world.google.account(OWNER_ACCOUNT.subject, OWNER_ACCOUNT.email);
    await world.send("/start");
    const url = (await world.press("Connect Google Calendar")) ?? "";
    const { callbackPath } = await world.authorize(url, OWNER_ACCOUNT);
    // Simulate a crash after the connection was saved but before the outcome was recorded.
    await env.DB.prepare("UPDATE oauth_states SET outcome = NULL").run();

    expect(await (await world.request(callbackPath)).text()).toContain(
      "✓ Google Calendar connected",
    );
    await env.DB.prepare("DELETE FROM google_connections").run();
    expect(await (await world.request(callbackPath)).text()).toContain(
      "I couldn't complete the connection",
    );
    expect(world.google.exchangeCalls).toBe(1);
  });

  it("stores nothing when consent is declined or Calendar permissions are unticked", async () => {
    const world = new World(env.DB);
    await world.send("/start");
    let url = (await world.press("Connect Google Calendar")) ?? "";
    expect((await world.authorize(url, { ...OWNER_ACCOUNT, deny: true })).page).toContain(
      "Connection cancelled",
    );

    await world.send("/start");
    url = (await world.press("Connect Google Calendar")) ?? "";
    const partial = await world.authorize(url, { ...OWNER_ACCOUNT, scopes: ["openid", "email"] });
    expect(partial.page).toContain("Calendar access wasn't granted");
    expect(await count(env.DB, "google_connections")).toBe(0);
  });

  it("does not replace the connected account without confirmation in Telegram", async () => {
    const world = new World(env.DB);
    const userId = await finishSetup(world);
    const other = { subject: "google-sub-other", email: "other@example.com" };

    await world.send("/settings");
    await world.press("Reconnect Google");
    let url = (await world.press("Reconnect Google Calendar")) ?? "";
    const mismatch = await world.authorize(url, other);
    expect(mismatch.page).toContain("This account differs from the one already connected");
    const [stillOwner] = await rows<{ email: string }>(
      env.DB,
      "SELECT email FROM google_connections",
    );
    expect(stillOwner?.email).toBe("owner@example.com");
    expect(world.lastText()).toContain(
      "You signed in as other@example.com, but owner@example.com is connected",
    );

    await world.press("Switch to other@example.com");
    url = (await world.press("Reconnect Google Calendar")) ?? "";
    expect((await world.authorize(url, other)).page).toContain("✓ Google Calendar connected");
    const [switched] = await rows<{ email: string }>(
      env.DB,
      "SELECT email FROM google_connections",
    );
    expect(switched?.email).toBe("other@example.com");
    const calendars = await rows<{ calendar_id: string }>(
      env.DB,
      "SELECT calendar_id FROM calendars WHERE user_id = ?",
      userId,
    );
    expect(calendars.map((c) => c.calendar_id)).toEqual(["google-sub-other@primary"]);
    const [user] = await rows<{ setup_step: string; task_calendar_id: string | null }>(
      env.DB,
      "SELECT setup_step, task_calendar_id FROM users",
    );
    expect(user).toEqual({ setup_step: "calendars", task_calendar_id: null });
  });

  it("refreshes expired access tokens and reuses them until they expire", async () => {
    const world = new World(env.DB);
    const userId = await connected(world);
    const deps = connectionDeps(world.services);

    world.clock.advance(2 * 60 * 60_000);
    await (await connectedCalendar(deps, userId))?.listCalendars();
    await (await connectedCalendar(deps, userId))?.listCalendars();
    expect(world.google.refreshCalls).toBe(1);
  });

  it("alerts once when access is revoked, and resumes paused work after reconnecting", async () => {
    const world = new World(env.DB);
    const userId = await finishSetup(world);
    world.google.revokeAll(OWNER_ACCOUNT.subject);
    world.clock.advance(2 * 60 * 60_000);
    const deps = connectionDeps(world.services);

    const result = await (await connectedCalendar(deps, userId))?.listCalendars();
    expect(result).toEqual({ ok: false, error: { kind: "auth_required" } });
    expect(await connectedCalendar(deps, userId)).toBeNull();
    await world.tick();
    await world.tick();
    const alerts = world.texts().filter((t) => t.startsWith("Google Calendar access has stopped"));
    expect(alerts).toHaveLength(1);

    await env.DB.prepare(
      `INSERT INTO operations (id, user_id, kind, idempotency_key, intent, status, created_at, updated_at)
       VALUES ('paused', ?, 'calendar.event.create', 'k', '{}', 'auth_required', 0, 0)`,
    )
      .bind(userId)
      .run();
    await world.send("/health");
    expect(world.lastText()).toContain("Google Calendar: Reconnection needed (owner@example.com)");

    await world.press("Reauthorize");
    const url = (await world.press("Reconnect Google Calendar")) ?? "";
    expect((await world.authorize(url, OWNER_ACCOUNT)).page).toContain(
      "✓ Google Calendar reconnected",
    );
    expect(world.texts()).toContain("Google Calendar reconnected. Paused changes will continue.");
    const [paused] = await rows<{ status: string }>(
      env.DB,
      "SELECT status FROM operations WHERE id = 'paused'",
    );
    expect(paused?.status).not.toBe("auth_required");
  });

  it("creates a named default calendar from a typed answer", async () => {
    const world = new World(env.DB);
    await connected(world);
    await world.press("Done");
    await world.press("Create a new calendar");
    expect(world.lastText()).toBe("Send a name for the new calendar.");
    await world.send("Work");
    expect(world.texts()).toContain(
      "Created Work. New events go there unless you name another calendar.",
    );
    expect(world.lastText()).toContain(TASK_CALENDAR_NAME);
  });

  it("links an existing task calendar only when the user chooses it", async () => {
    const world = new World(env.DB);
    const existing = {
      calendarId: "old-tasks@group.test",
      summary: TASK_CALENDAR_NAME,
      accessRole: "owner" as const,
      primary: false,
    };
    world.google.account(OWNER_ACCOUNT.subject, OWNER_ACCOUNT.email, [PRIMARY, existing]);
    await world.send("/start");
    await world.authorize((await world.press("Connect Google Calendar")) ?? "", OWNER_ACCOUNT);
    await world.press("Done");
    await world.press("owner@example.com");
    expect(world.lastText()).toContain("already exists in your account");

    await world.press("Use existing");
    const [user] = await rows<{ task_calendar_id: string }>(
      env.DB,
      "SELECT task_calendar_id FROM users",
    );
    expect(user?.task_calendar_id).toBe("old-tasks@group.test");
    expect(world.google.accounts.get(OWNER_ACCOUNT.subject)?.calendars).toHaveLength(2);
  });

  it("does not create a second calendar when the create response was lost", async () => {
    const world = new World(env.DB);
    await connected(world);
    await world.press("Done");
    await world.press("owner@example.com");
    world.google.createLosesResponse = true;
    await world.press("Create calendar");
    expect(world.lastText()).toContain("couldn't confirm");

    world.clock.advance(60 * 60_000);
    await world.tick();
    const tasks = world.google.accounts
      .get(OWNER_ACCOUNT.subject)
      ?.calendars.filter((c) => c.summary === TASK_CALENDAR_NAME);
    expect(tasks).toHaveLength(1);
    expect(world.texts()).toContain(`Created ${TASK_CALENDAR_NAME} for task deadlines.`);
  });

  it("validates timezone changes from /settings", async () => {
    const world = new World(env.DB);
    await finishSetup(world);
    await world.send("/settings");
    await world.press("Timezone");
    await world.press("Change timezone");
    await world.send("Mars/Olympus_Mons");
    expect(world.lastText()).toContain("I don't recognize that timezone");
    await world.send("Europe/London");
    expect(world.lastText()).toBe(
      "Timezone set to Europe/London. Existing events keep their times; new dates and reminders use Europe/London.",
    );
  });

  it("ignores another user's buttons", async () => {
    const world = new World(env.DB);
    await connected(world);
    const before = world.telegram.calls.length;
    await world.press("Done", OTHER_USER);
    expect(world.answers().at(-1)).toBe("This button is no longer valid.");
    expect(world.telegram.calls.length).toBe(before + 1);
    const [owner] = await rows<{ setup_step: string }>(
      env.DB,
      "SELECT setup_step FROM users WHERE telegram_user_id = ?",
      OWNER,
    );
    expect(owner?.setup_step).toBe("calendars");
  });
});

describe("public pages", () => {
  it("serves the homepage and privacy policy with strict headers and no scripts", async () => {
    const world = new World(env.DB);
    for (const path of ["/", "/privacy"]) {
      const response = await world.request(path);
      const html = await response.text();
      expect(response.status).toBe(200);
      expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
      expect(html).not.toContain("<script");
    }
    expect(await (await world.request("/privacy")).text()).toContain("Limited Use requirements");
  });
});
