# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

The main experience is a Telegram bot, using Telegram's native presentation.
Google Calendar provides the visual calendar interface. Custom web surfaces are
a landing page at `/`, the Google connection pages, and a Telegram Mini App for
tasks and a read-only day/week overview. There is no separate calendar web
application.

## Stack

TypeScript on Cloudflare Workers, D1, and a per-minute scheduled tick.
Connection pages are Worker-rendered HTML. The landing page is React, Tailwind
and Motion, prerendered at build time and served as static assets by the same
Worker ([ADR 0006](docs/adr/0006-landing-page-as-static-assets.md)). The Mini App is vanilla TypeScript
bundled with esbuild, with Motion's small vanilla build for springs; no frontend
framework ([ADR 0005](docs/adr/0005-mini-app-surface-and-initdata-auth.md)).

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

Released as 2.1.0 (2026-10-15; 2.0.0 on 2026-10-14) and in daily use by the owner. Product
specification, backend plan and its implementation record, the approved logo and
design system, the [experience brief](docs/design/experience.md), the
[acceptance matrix](docs/acceptance.md), and [capacity measurements](docs/capacity.md).
No measured outcomes from other users. Examples are synthetic.

## Product Principles

- Capture quickly; ask only for missing information.
- Make deadlines, reminders, and operation status explicit.
- Keep daily views compact, with actions available at the relevant item.
- Preserve user control over consequential changes.
- Keep the identity present without adding conversational overhead.

## Open Decisions

Logo and design system approved 2026-10-09. A narrow single-column connection layout
and explicit Continue in Telegram action are approved; no automatic return. See
[the connection-page plan](docs/plans/connection-pages.md) for implementation details.
Do not infer a separate web app from this platform record. The one approved
exception is a Telegram Mini App for tasks and a read-only day/week overview
(owner, 2026-10-08; [improvement plan](docs/plans/improvements.md)).
