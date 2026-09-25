# Oh My Days — initial identity

Status: Working creative direction for discussion, not a finalized brand system.  
Date: 2026-09-25

## Core idea

**A little less to keep in your head.**

Oh My Days helps turn everyday messages into clear commitments. Capture a task,
check your day, and get a useful nudge without maintaining another planning app.
Telegram is where you talk; Google Calendar is where you see the schedule.

The name carries a small moment of recognition: life gets busy, and getting it
back in order can feel lighter. The application should feel calm, capable, and
lightly playful. It must never make busyness or overdue work feel like failure.

## Naming and positioning

- Display name: **Oh My Days**.
- Repository/service stem: `oh-my-days`; suffix environments explicitly.
- Dedicated task calendar: **Tasks - Oh My Days**, exactly as specified.
- Draft tagline: **A little less to keep in your head.**
- Short description: **Your days and to-dos, a message away.**
- Bot profile draft: **Plan events, capture tasks, and get timely reminders in
  Telegram, with your schedule in Google Calendar. Private access for now.**

Do not abbreviate the display name to OMD in user messages. Telegram usernames,
domains, trademarks, and deployed service identifiers have not been checked or
reserved. Choose the bot username after an availability check; keep it separate
from the display name.

## Voice

Be warm, brief, specific, and honest. Lead with what happened and the exact time
or deadline. Use ordinary words. Acknowledge overdue tasks without guilt. Reserve
humor for low-stakes onboarding; keep errors, conflicts, and invitations direct.

| Situation | Example wording |
|---|---|
| Event created | Event added: Dinner · Fri 25 Sep, 7–8pm · Asia/Singapore. |
| Task created | Task added to Inbox: Buy milk. Due Sat 26 Sep. |
| No deadline | Task added to Inbox: Buy milk. No deadline. |
| Snoozed | I'll remind you on Monday at 9am. The deadline stays Friday. |
| Calendar unavailable | Saved as pending. Google Calendar hasn't updated yet. I'll retry. |
| Conflict | This event moved to 5pm in Calendar. Keep 5pm or use 4pm? |
| Invitation preview | Send an invitation to alex@example.com for Dinner on Fri 25 Sep, 7–8pm? |
| Structured fallback | Please use /task or /event for this request. I'll guide you through it. |
| Overdue summary | 3 tasks are overdue. View tasks · Snooze |

Examples illustrate tone, not a complete message contract. Actual messages must
include relevant year, timezone, calendar, recipients, and scope when needed to
avoid ambiguity. Distinguish “Task added,” “Event added,” and “Pending.” Buttons
use explicit verbs such as Done, Snooze, Undo, Reauthorize, and Confirm cancellation.
Do not claim perfect privacy, guaranteed delivery, or instant synchronization.

## Visual direction to explore later

A warm paper background, dark ink, and a restrained sunrise accent could connect
the name to a fresh start without becoming a productivity dashboard cliché.
Candidate colors: paper `#FAF7F0`, ink `#24332F`, moss `#426B58`, sunrise `#E9AD55`.
These are exploration swatches; contrast and accessibility are not yet validated.

Explore a small calendar-page mark with a rising sun. It must remain recognizable
at Telegram avatar size and in monochrome. Keep the full wordmark in normal title
case. Use a readable humanist sans-serif direction; choose fonts and licensing
when designing actual surfaces. Do not rely on color alone to convey task state.

The next design conversation should decide the mark, palette, typography, and
which authorization/onboarding surfaces are needed. This draft does not introduce
a separate calendar or task-management frontend into the agreed product scope.
