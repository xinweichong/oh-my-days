/**
 * Server-rendered pages for the Google connection flow, homepage, and privacy
 * policy (docs/plans/connection-pages.md, ADR 0002). No scripts; one narrow
 * column; plain light background with one restrained accent.
 */

import type { AuthorizationOutcome } from "../application/google-connection";
import { TASK_CALENDAR_NAME } from "../application/setup";
import { TAGLINE } from "../telegram/messages";

/** Escapes text and double-quoted attribute values (all attributes here use double quotes). */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
}

const STYLE = `
:root { color-scheme: light; --text: #1d1d1f; --muted: #555b61; --accent: #1f5fbf;
  --accent-text: #ffffff; --line: #d9dde2; --bg: #ffffff; --focus: #0b3d91; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text);
  font: 1rem/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { max-width: 34rem; margin: 0 auto; padding: 2.5rem 1.25rem 3rem; }
.brand { font-weight: 600; margin: 0; }
.tagline { color: var(--muted); margin: 0 0 2rem; }
h1 { font-size: 1.5rem; line-height: 1.3; margin: 0 0 0.75rem; }
h2 { font-size: 1.1rem; margin: 1.75rem 0 0.5rem; }
p, li { overflow-wrap: anywhere; }
.action { display: inline-block; margin: 1rem 0 0.5rem; padding: 0.8rem 1.25rem; min-height: 44px;
  border: 0; border-radius: 6px; background: var(--accent); color: var(--accent-text);
  font: inherit; font-weight: 600; text-decoration: none; cursor: pointer; }
.action:hover { filter: brightness(0.92); }
a:focus-visible, button:focus-visible, summary:focus-visible { outline: 3px solid var(--focus);
  outline-offset: 2px; }
.support { color: var(--muted); margin: 0.25rem 0 1.5rem; }
details { border-top: 1px solid var(--line); padding-top: 1rem; }
summary { cursor: pointer; font-weight: 600; min-height: 44px; }
a { color: var(--accent); }
footer { margin-top: 2.5rem; color: var(--muted); font-size: 0.9rem; }
`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<p class="brand">Oh My Days</p>
<p class="tagline">${escapeHtml(TAGLINE)}</p>
${body}
</main>
</body>
</html>`;
}

const ACCESS_DETAILS = `
<details>
<summary>Access and data details</summary>
<p>Google will ask you to allow Oh My Days to:</p>
<ul>
<li>See, create, change, and delete events in the calendars your Google account can access.</li>
<li>See the list of calendars in your account.</li>
<li>Create new calendars, and manage the calendars Oh My Days creates.</li>
<li>See your email address, to know which Google account is connected.</li>
</ul>
<p>Google grants event access to all of your calendars. Choosing calendars in Telegram limits what Oh My Days does; it does not limit what Google allows.</p>
<p>Oh My Days creates a calendar named “${escapeHtml(TASK_CALENDAR_NAME)}” for task deadlines. It never changes who your calendars are shared with, and it cannot delete calendars it did not create.</p>
<p>Access tokens are stored encrypted. Calendar data is used only to carry out your requests, views, and reminders. See the <a href="/privacy">privacy policy</a>.</p>
<p>You can remove access at any time from your Google Account’s <a href="https://myaccount.google.com/connections">third-party connections</a>.</p>
</details>`;

export function connectPage(linkToken: string): string {
  return page(
    "Connect Google Calendar · Oh My Days",
    `<h1>Connect Google Calendar</h1>
<p>View and manage events in the calendars you select. Task deadlines appear in ‘${escapeHtml(TASK_CALENDAR_NAME)}.’</p>
<form method="post" action="/oauth/start">
<input type="hidden" name="t" value="${escapeHtml(linkToken)}">
<button class="action" type="submit">Connect Google Calendar</button>
</form>
<p class="support">You'll choose your calendars in Telegram.</p>
${ACCESS_DETAILS}`,
  );
}

interface OutcomeCopy {
  heading: string;
  body: string;
  action: string;
}

const OUTCOME_COPY: Record<AuthorizationOutcome, OutcomeCopy> = {
  connected: {
    heading: "✓ Google Calendar connected",
    body: "Choose your calendars and finish setup in Telegram.",
    action: "Continue in Telegram",
  },
  reconnected: {
    heading: "✓ Google Calendar reconnected",
    body: "Return to Telegram to continue.",
    action: "Continue in Telegram",
  },
  declined: {
    heading: "Connection cancelled",
    body: "Google Calendar wasn't connected. Return to Telegram to reconnect.",
    action: "Return to Telegram",
  },
  invalid_link: {
    heading: "This connection link is no longer valid",
    body: "Open Telegram to request a new one.",
    action: "Return to Telegram",
  },
  provider_failure: {
    heading: "I couldn't complete the connection",
    body: "Return to Telegram to try again. If it keeps happening, check /health.",
    action: "Return to Telegram",
  },
  account_mismatch: {
    heading: "This account differs from the one already connected",
    body: "Nothing was changed. Confirm the account change in Telegram.",
    action: "Return to Telegram",
  },
  missing_scopes: {
    heading: "Calendar access wasn't granted",
    body: "Google Calendar wasn't connected because some permissions were left unselected. Return to Telegram to try again, and keep all the Calendar permissions selected.",
    action: "Return to Telegram",
  },
};

export function outcomePage(outcome: AuthorizationOutcome, telegramUrl: string): string {
  const copy = OUTCOME_COPY[outcome];
  return page(
    `${copy.heading.replace(/^✓ /, "")} · Oh My Days`,
    `<h1>${escapeHtml(copy.heading)}</h1>
<p>${escapeHtml(copy.body)}</p>
<a class="action" href="${escapeHtml(telegramUrl)}">${escapeHtml(copy.action)}</a>
<p class="support">If the button doesn't open Telegram, open your conversation with the bot directly.</p>`,
  );
}

export function homePage(): string {
  return page(
    "Oh My Days",
    `<h1>Events, tasks, and reminders in Telegram</h1>
<p>Oh My Days is a private Telegram assistant for scheduling. You send it a message, and it adds or updates events in your Google Calendar, keeps track of tasks and their deadlines, and reminds you before they're due.</p>
<p>Google Calendar remains where you see your schedule. Task deadlines appear in a separate calendar, “${escapeHtml(TASK_CALENDAR_NAME)},” so they don't mark you as busy.</p>
<p>Access is limited to invited users. There is no public sign-up.</p>
<footer><a href="/privacy">Privacy policy</a></footer>`,
  );
}

export function privacyPage(contactEmail: string | null): string {
  const contact = contactEmail
    ? `<p>Questions or deletion requests: <a href="mailto:${escapeHtml(contactEmail)}">${escapeHtml(contactEmail)}</a>.</p>`
    : "<p>Questions or deletion requests: contact the person who invited you to use Oh My Days.</p>";
  return page(
    "Privacy policy · Oh My Days",
    `<h1>Privacy policy</h1>
<p>Effective 3 October 2026.</p>
<p>Oh My Days is a private Telegram assistant run by an individual for invited users. This policy explains what it stores and why.</p>

<h2>What Oh My Days stores</h2>
<ul>
<li><strong>Telegram:</strong> your Telegram user ID and private chat ID, and the messages and button presses you send to the bot. Message text is kept only until it has been processed, then deleted; a record that the message was handled is kept for 7 days to prevent duplicates.</li>
<li><strong>Google account:</strong> your Google account email and a stable account identifier, the permissions you granted, and access tokens. Tokens are encrypted with a key that is not stored in the database.</li>
<li><strong>Calendars:</strong> the names, identifiers, and access levels of calendars in your account, which calendars you selected, your default calendar, and the task calendar.</li>
<li><strong>Events:</strong> a copy of the title, time, and a few properties (such as whether it has guests or is marked free) of events in the calendars you selected, refreshed from Google every few minutes. One-off events that ended more than 30 days ago are not kept, and a calendar's copy is deleted when you deselect it. Event descriptions, locations, and guest lists are not stored.</li>
<li><strong>Your requests:</strong> changes you ask for (for example, an event's title and time) are recorded until they have been carried out and for up to 30 days afterwards, so they can be retried safely and undone.</li>
<li><strong>Settings:</strong> your timezone and similar preferences.</li>
</ul>

<h2>How Google user data is used</h2>
<p>Oh My Days uses Google Calendar data only to provide the features you use: showing your schedule, adding and changing events and task deadlines you request, detecting overlaps, and sending reminders. It does not sell this data, use it for advertising, or transfer it to anyone except as needed to provide these features, comply with law, or protect against abuse. People do not read your calendar data except with your permission, for security, or as required by law.</p>
<p>Oh My Days's use and transfer of information received from Google APIs adheres to the <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>, including the Limited Use requirements.</p>

<h2>Services involved</h2>
<p>The application runs on Cloudflare (Workers and D1 database). Messages pass through Telegram. Calendar data comes from and goes to Google. Natural-language interpretation is not currently used; if it is added, only sanitized scheduling wording without calendar contents, names, email addresses, or locations will be sent, and this policy will be updated first.</p>

<h2>Retention and deletion</h2>
<p>Data is kept while you use Oh My Days. You can remove Google access at any time from your Google Account’s <a href="https://myaccount.google.com/connections">third-party connections</a>; Oh My Days then stops reading or changing your calendars. You can ask for your data to be deleted, and it will be removed within 30 days.</p>
${contact}
<footer><a href="/">Oh My Days</a></footer>`,
  );
}

/** Security headers for every HTML response. No scripts are ever served. */
export function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self' https://accounts.google.com; base-uri 'none'; frame-ancestors 'none'",
    },
  });
}
