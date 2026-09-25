# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

The custom interface consists of minimal browser-based Google authorization pages.
The main experience is a Telegram bot, using Telegram's native presentation.
Google Calendar provides the visual calendar interface. There is no separate
calendar or task-management web application in the agreed scope.

## Stack

Backend proposal: TypeScript on Cloudflare Workers, D1, and scheduled work.
The connection-page plan proposes small Worker-rendered HTML templates and shared
CSS; no frontend framework has been selected or implemented. The user requested
a written plan and explicitly declined a prototype.

## Users

Initially the owner, with a small number of independent allowlisted users supported
by the architecture. Users capture commitments and check their day inside Telegram.

## Product Purpose

Capture events and tasks, synchronize supported changes with Google Calendar, and
provide agendas and reminders without requiring another planning interface.

## Positioning

A little less to keep in your head. Users operate through Telegram, while Google
Calendar shows events and dedicated task deadline markers. Application-owned task
state preserves lists, snoozes, and independent recurring occurrences.

## Operating Context

One instruction per message. Typing first, guided commands and buttons available.
One Google account per user and multiple selected calendars. Initial timezone:
Asia/Singapore. Daily agenda at 8am local time. Google authorization is in the browser;
calendar selection and settings are in Telegram.

## Capabilities and Constraints

The [spec](docs/specs/oh-my-days.md) owns product scope and acceptance criteria;
the [backend plan](docs/plans/backend.md) describes proposed implementation.
Free services only; no paid fallback. Deterministic features work without AI.
Private input is never sent raw to Gemini. Confirm deletion, whole-series changes,
and notifications to attendees. Pending operations cannot be presented as success.

## Brand Commitments

Name: Oh My Days. Tagline: A little less to keep in your head.
Brief, factual language with light first-person personalization. Do not address the
user by name. Emoji only for functional symbols. No jokes, praise, or productivity
guilt. Logo design deferred. See [identity](docs/identity/oh-my-days.md).

## Evidence on Hand

Product specification, backend proposal, and user-confirmed interview decisions in
[the experience brief](docs/design/experience.md). No running application, final
logo, approved visual mockup, or measured user outcomes exist. Examples are synthetic.

## Product Principles

- Capture quickly; ask only for missing information.
- Make deadlines, reminders, and operation status explicit.
- Keep daily views compact, with actions available at the relevant item.
- Preserve user control over consequential changes.
- Keep the identity present without adding conversational overhead.

## Open Decisions

Exact visual tokens and logo remain open. A narrow single-column connection layout
and explicit Continue in Telegram action are approved; no automatic return. See
[the connection-page plan](docs/plans/connection-pages.md) for implementation details.
Do not infer a separate web app from this platform record.
