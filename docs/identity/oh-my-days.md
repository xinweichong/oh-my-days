# Oh My Days — identity

Status: Name, voice, and minimal presentation direction confirmed in the design interview. Logo and detailed visual system deferred.

Date: 2026-09-25

## Core idea

**A little less to keep in your head.**

Oh My Days turns messages into events, tasks, and reminders. Telegram is where you
talk; Google Calendar is where you see the schedule. Preserve the small amount of
character in the name and tagline throughout the experience, without making routine
interactions chatty or emotional.

The user initially asked for an objective interface, then clarified that the
identity should remain present and slightly personalized. The resulting rule is:
**brief, factual messages with light first-person language, without addressing the
user by name.** This supersedes the earlier lightly playful creative proposal.

## Naming and positioning

- Display name: **Oh My Days**.
- Tagline: **A little less to keep in your head.**
- Factual supporting description: Events, tasks, and reminders in Telegram, connected
  to Google Calendar. Supporting copy is a draft, not a replacement for the tagline.
- Repository/service stem: `oh-my-days`; suffix environments explicitly.
- Dedicated task calendar: **Tasks - Oh My Days**, exactly as specified.

Keep the full display name in user-facing branding. Bot usernames, domains,
trademarks, and deployed identifiers have not been checked or reserved.

## Voice rules

- Lead with the result, relevant date/time, or action needed.
- Use first-person language when it makes the interaction natural: “I'll remind
  you tomorrow” and “I'll retry automatically.” Do not force “I” into every response.
- Do not greet or address users by name, including agendas and onboarding.
- Keep routine confirmations and errors factual. No jokes, praise, encouragement,
  guilt, celebratory language, or commentary about the user's productivity.
- Let the identity appear in small phrases such as “Here's your day” and “Your
  calendar is clear today.” Use the tagline on introductory surfaces; do not repeat
  it on every notification.
- Use emoji only as functional symbols. For example, ✓ communicates completion.
  No decorative emoji, mascots, or mood-setting symbols. Pair status symbols with
  text where their meaning could be unclear; do not replace action labels with emoji.
- Never imply a Calendar operation succeeded while pending, or promise perfect
  privacy, instant synchronization, or guaranteed delivery.

## Copy examples

Examples use synthetic data and illustrate the confirmed voice. Include the year,
timezone, calendar, recipients, and recurrence scope when needed for clarity.

| Situation | Example wording |
|---|---|
| Introduction | A little less to keep in your head. Connect Google Calendar to get started. |
| Daily agenda | Here's your day. |
| Empty event section | Your calendar is clear today. |
| Event created | Event added: Dinner · Fri 25 Sep 2026, 7–8pm · Personal. |
| Task created | Task added to Inbox: Buy milk. Due Sat 26 Sep. |
| No deadline | Task added to Inbox: Buy milk. No deadline. |
| Snoozed | I'll remind you on Sat 26 Sep at 8am. Deadline unchanged: Fri 25 Sep, 3pm. |
| Calendar unavailable | Pending: Dinner has not been added to Google Calendar. I'll retry automatically. |
| Conflict | This event moved to 5pm in Calendar. Keep 5pm or use 4pm? |
| Clarification | Which Friday? |
| Guided fallback | I can't process this request automatically. Continue with guided input. |
| Overdue summary | 3 tasks are overdue. |

“Your calendar is clear today” refers only to events. Do not use it to imply there
are no due or overdue tasks. Keep task sections visible when relevant.

## Presentation direction

Use a plain light background, dark text, and one restrained accent for primary
buttons on connection pages. No illustrations, gradients, or decorative animation.
Use readable type, clear hierarchy, and explicit action labels. Telegram retains
its native fonts, colors, and message/button appearance.

Logo design is on hold. No symbol, mascot, or logo concept is approved. The earlier
calendar/sun concept and palette were exploratory and are not binding. Exact colors,
typefaces, spacing tokens, and dark-mode behavior remain undecided. Validate contrast
and keyboard/focus behavior when building web pages; never use color alone for status.

## Related decisions

See the [experience brief](../design/experience.md) for the confirmed Telegram and
connection-page flows. This identity does not add a standalone planning frontend.
