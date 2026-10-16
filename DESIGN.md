---
name: Oh My Days
description: A little less to keep in your head. Events, tasks and reminders in Telegram, connected to Google Calendar.
colors:
  tide: "#0b6b62"
  tide-soft: "#e2f1ee"
  on-tide: "#ffffff"
  marigold: "#f2a32c"
  overdue: "#a34a06"
  overdue-soft: "#fbeadb"
  danger: "#b42318"
  danger-soft: "#fdecea"
  ink: "#13201e"
  ink-muted: "#51605d"
  surface: "#ffffff"
  surface-sunk: "#f2f5f4"
  surface-raised: "#ffffff"
  line: "#d3dcda"
  line-strong: "#7d8e8b"
  chat: "#e9efed"
  bubble-out: "#dcefe9"
typography:
  display:
    fontFamily: "Figtree, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "clamp(2.6rem, 6vw, 4.5rem)"
    fontWeight: 600
    lineHeight: 1.02
    letterSpacing: "-0.03em"
  headline:
    fontFamily: "Figtree, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "2.25rem"
    fontWeight: 600
    lineHeight: 1.05
    letterSpacing: "-0.025em"
  title:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, sans-serif"
    fontSize: "20px"
    fontWeight: 600
    lineHeight: "26px"
  item:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, sans-serif"
    fontSize: "17px"
    fontWeight: 500
    lineHeight: "22px"
  body:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: "24px"
  meta:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: "20px"
    fontFeature: "tnum"
  label:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, sans-serif"
    fontSize: "12px"
    fontWeight: 600
    lineHeight: "16px"
    letterSpacing: "0.04em"
rounded:
  sm: "6px"
  inset: "8px"
  md: "12px"
  card: "16px"
  full: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  xxl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.tide}"
    textColor: "{colors.on-tide}"
    rounded: "{rounded.md}"
    padding: "10px 16px"
    height: "44px"
  button-secondary:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "10px 16px"
    height: "44px"
  button-plain:
    textColor: "{colors.tide}"
    padding: "0 12px"
    height: "44px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "8px 12px"
    height: "44px"
  list-group:
    backgroundColor: "{colors.surface-raised}"
    rounded: "{rounded.md}"
  list-row:
    typography: "{typography.item}"
    padding: "0 0 0 16px"
    height: "44px"
  next-up:
    backgroundColor: "{colors.tide-soft}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "12px 4px 12px 16px"
  check-circle:
    rounded: "{rounded.full}"
    size: "24px"
  check-circle-checked:
    backgroundColor: "{colors.tide}"
    textColor: "{colors.on-tide}"
    rounded: "{rounded.full}"
    size: "24px"
  toast:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "8px 8px 8px 16px"
  landing-cta-primary:
    backgroundColor: "{colors.tide}"
    textColor: "{colors.on-tide}"
    rounded: "{rounded.inset}"
    padding: "0 24px"
    height: "48px"
  landing-cta-secondary:
    textColor: "{colors.ink}"
    rounded: "{rounded.inset}"
    padding: "0 24px"
    height: "48px"
  landing-thought-chip:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.ink}"
    rounded: "{rounded.full}"
    padding: "0 16px"
    height: "40px"
---

# Design System: Oh My Days

## Overview

**Creative North Star: "The Eight O'Clock Sunrise"**

The system is named for its logo: a marigold half-sun clearing a tide horizon, the agenda that arrives with the morning. Everything else is the horizon line, not the sun. Surfaces are plain and quiet, text is dark ink, and one tide green carries every action, selection and "today". The product (Mini App, connection pages, privacy policy) speaks in the platform's own system type at reading sizes, with Telegram keeping its native fonts, colours and bubbles.

Density is calm and list-shaped: grouped rows on raised cards, 44px touch targets, tabular figures for times and counts, status always stated in words as well as colour. Depth is quiet: rows and lists stay flat, and only the few things that sit above the page (the next-up card, Home's tiles, sheets and toasts) carry a soft shadow.

The landing page at `/` is the one recorded marketing exception (owner, 2026-10-15). Because it persuades rather than operates, it may use Figtree for display headings, soft two-layer shadows, and decorative motion (drifting thoughts, slow tide contour lines). It still holds every other rule: tide is the one brand colour, marigold stays in the logo, the sun never animates, body text is system UI, and its demo rows are drawn from the product's real components.

The Mini App shares part of that finish (owner, 2026-10-16; [ADR 0007](docs/adr/0007-mini-app-display-type-and-depth.md)): Figtree for screen titles and large figures, the soft shadow on its floating layers, static tide lines behind Home's heading and slowly drifting ones on the All clear screen, and the mark beside Home's heading. Body text, rows, buttons and forms stay system UI and flat. The connection pages and privacy policy keep the plain rules.

**Key Characteristics:**
- One brand colour (tide), used for actions, selection, focus and today.
- Marigold exists only inside the logo.
- System UI type for reading; Figtree for the wordmark, landing headings, and Mini App titles and large figures.
- Light and dark palettes, with the Mini App deferring to Telegram theme colours where Telegram provides them.
- 4px spacing rhythm, 44px minimum touch targets, 12px corners on fields and buttons, 16px on Mini App cards.
- Flat rows and lists; soft depth only on floating layers; decorative motion only on the landing page and the All clear screen.

## Colors

A cool, near-neutral palette tinted toward green-grey, with one deep teal-green accent and one warm caution tone.

### Primary
- **Tide** (#0b6b62; dark #4fbfb1): The one brand colour. Primary buttons, plain-button and link labels, checked circles, the selected row wash, the focus ring, today's day heading, the next-time figure, the toast timer bar and the text caret. On the landing page it also fills the closing band and draws the contour lines.
- **Tide Soft** (#e2f1ee; dark #123532): Quiet tide wash for the "next up" card, selected rows, text selection and the bot avatar disc.
- **On Tide** (#ffffff; dark #062421): Text and glyphs placed on tide.

### Secondary
- **Overdue Amber** (#a34a06; dark #f0a05a): Overdue counts and the "overdue" label. Always paired with words, never colour alone.
- **Overdue Soft** (#fbeadb; dark #3a2414): Background for overdue emphasis.
- **Danger Red** (#b42318; dark #ff8a80, or Telegram's destructive colour): Destructive actions only, as outlined text buttons and banners.
- **Danger Soft** (#fdecea; dark #3b1512): Error banner background.

### Tertiary
- **Logo Marigold** (#f2a32c): The sun in the logo, in every lockup and both themes. Nowhere else.

### Neutral
- **Ink** (#13201e; dark #e6eeec): Primary text and the wordmark.
- **Ink Muted** (#51605d; dark #9caca9): Meta, captions, section labels, times, chevrons, completed items.
- **Surface** (#ffffff; dark #0e1615): Page background on the landing page and connection pages; field backgrounds in the Mini App.
- **Surface Sunk** (#f2f5f4; dark #0a1110): The Mini App page background behind grouped cards; alternating landing bands.
- **Surface Raised** (#ffffff; dark #162120): Cards, list groups, toasts, chips.
- **Line** (#d3dcda; dark #283634): Row separators, section rules, header and footer borders.
- **Line Strong** (#7d8e8b; dark #5d6f6c): Unchecked circle stroke, field strokes, strikethrough on cancelled items.
- **Chat Wall** (#e9efed; dark #0b1312) and **Outgoing Bubble** (#dcefe9; dark #133a35): Landing page only, for the Telegram conversation mockups.

### Named Rules
**The One Tide Rule.** Tide is the only brand colour. Every action, selection and focus state is tide; no second accent is introduced on any surface.

**The Sun Stays in the Sky Rule.** Marigold appears only as the logo's sun, and the sun never animates.

**The Words Before Colour Rule.** Status is never carried by colour alone: overdue says "overdue", pending says "pending", completion pairs ✓ with the row state.

## Typography

**Display Font:** Figtree (with system-ui fallback): the wordmark, landing headings, and Mini App titles and large figures. The Mini App serves its own copy of the Latin subset (no third-party font requests).
**Body Font:** system UI stack (system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, sans-serif)

**Character:** The product reads like the phone it runs on: native system type at comfortable sizes, with weight rather than size doing most of the hierarchy. Figtree, the wordmark's face, gives headings and the numbers people glance at a rounded, friendly voice at semibold weight with tight tracking.

### Hierarchy
- **Display** (Figtree 600, 2.6rem rising to 4.5rem at 1024px, line-height 1.02, -0.03em): The landing page h1 (the tagline) only.
- **Headline** (Figtree 600, 2.25rem rising to 3rem or 3.75rem from 768px, line-height 1.05, -0.025em): Landing section headings, held to about 16-18ch. Landing subheads step down to Figtree 600 at 1.5rem, -0.015em.
- **Title** (Figtree 600, 32px/36px, -0.03em): Mini App screen titles; Home's weekday runs at 38px/40px. Sheet titles step down to Figtree 600 at 20px/24px, -0.015em, as do Home's tile and section headings.
- **Figure** (Figtree 600, 36-40px, -0.03em, tabular): Home's tile counts and the next-up time.
- **Item** (500, 17px/22px): Row headlines, the next-up figure and wide tile labels.
- **Body** (400, 16px/24px): Default product text. Landing lead paragraphs run larger (18px/28px, 20px/32px from 768px) in ink muted, held to 34-56ch.
- **Meta** (400, 14px/20px, tabular figures): Times, dates, counts and secondary row lines; captions at 13px/18px.
- **Label** (600, 12px/16px, 0.04em, uppercase): Mini App day and section group headings in ink muted, and the weekday labels in calendar views. A grouping label above a list, not a decorative eyebrow above a heading.

### Named Rules
**The System Voice Rule.** Reading text is system UI. Figtree appears only in the wordmark, landing headings and the count figure, and Mini App titles and large figures; never in body copy, row text, buttons or forms. The connection pages and privacy policy use no Figtree.

**The Tabular Time Rule.** Every time, date number and count uses tabular figures so columns of times align.

## Layout

Spacing runs on a 4px base (4, 8, 12, 16, 24, 32). The Mini App is a single column with 16px side gutters (plus Telegram safe-area insets), list groups separated by 24px label gaps, and every interactive row at least 44px tall. Connection pages are a single centred reading column (34rem).

The landing page sits in a 76rem container with 16 / 24 / 32px gutters at phone, 640px and 768px, and sections spaced 80px (112px from 768px) apart, alternating surface and surface-sunk bands divided by a 1px line. It has two compositions: from 1024px the hero splits 5/12 headline and 7/12 thought field on a 12-column grid; below that the headline stacks over two horizontally drifting rows of thoughts. The scroll-pinned walkthrough starts at 768px; phones get a stacked sequence revealed in view. Breakpoints in use: 26rem, 40rem, 48rem, 64rem.

## Elevation & Depth

Rows and lists are flat. Depth comes from tonal layering: raised white cards on a sunk grey-green page, separated by 1px lines. Pressed states darken in place with an inset wash rather than lifting.

In the Mini App, the things that sit above the page take the soft shadow: the next-up card, Home's tiles, bottom sheets and toasts. The overdue tile tints its shadow with the overdue colour. Nothing else lifts.

The landing page, under its exception, uses two soft ink-tinted shadows: a resting soft shadow on thought chips, the primary CTA and device frames, and a deeper lift shadow on hover.

### Shadow Vocabulary
- **Toast** (`box-shadow: 0 4px 16px rgba(19, 32, 30, 0.16)`; dark `rgba(0, 0, 0, 0.5)`): Toasts.
- **Soft** (`box-shadow: 0 1px 2px rgb(19 32 30 / 0.06), 0 10px 30px -12px rgb(19 32 30 / 0.22)`; dark `0 1px 2px rgb(0 0 0 / 0.4), 0 10px 30px -12px rgb(0 0 0 / 0.6)`): Landing page resting depth; the Mini App's next-up card, Home tiles and sheets.
- **Lift** (`box-shadow: 0 2px 4px rgb(19 32 30 / 0.06), 0 24px 48px -20px rgb(19 32 30 / 0.3)`): Landing page hover depth and the frames that carry the walkthrough.

### Named Rules
**The Flat Rows Rule.** Rows, list groups, buttons and fields carry no shadow. In the product, only floating layers (the next-up card, Home tiles, sheets, toasts) take the soft shadow; the lift shadow belongs to the landing page.

## Shapes

Corners are gently rounded and consistent: 16px on Mini App cards, tiles and list groups (18px on the next-up card, 16px on the top of sheets); 12px on banners, fields, toasts and product buttons; 8px for a button nested inside a field and for landing CTAs; 6px for the connection-page action button; fully round for check circles, chips, avatars and the composer. Borders are 1px hairlines in line or line-strong; the unchecked check circle is a 2px line-strong ring. On the landing page, device frames and the closing tide band use larger radii (28px on the band) to read as objects rather than UI.

## Components

### Buttons
Plain and confident: solid tide for the one primary action, quiet everywhere else.
- **Shape:** Gently rounded (12px in the product; 8px landing CTAs).
- **Primary:** Tide fill, on-tide label, semibold, at least 44px tall (48px on landing CTAs), 10px 16px padding.
- **Hover / Focus:** Focus is a 3px tide outline offset 2px on every surface. Product buttons dim with a 120ms opacity transition; landing CTAs brighten and lift to the lift shadow over 200ms on the expo-out curve, with the › nudging 2px right.
- **Secondary:** Raised surface with an inset 1px line ring (product); a line-strong outline turning tide on hover (landing).
- **Plain / Text:** Tide label, no fill, 44px tall.
- **Danger:** No fill, danger-red label and inset 1px danger ring; only for destructive actions, always behind confirmation.

### Cards / Containers
- **Corner Style:** 16px (18px on the next-up card).
- **Background:** Surface raised on surface sunk. The next-up card is raised, with its time in a tide-soft block; the overdue tile uses overdue soft.
- **Shadow Strategy:** Soft on the next-up card and Home tiles only (see Elevation & Depth).
- **Border:** None on the card; rows inside are divided by 1px line rules inset from the left edge.
- **Internal Padding:** 12-16px.

### Inputs / Fields
- **Style:** 1px line-strong stroke, 12px radius, surface background, 44px tall, 8px 12px padding, tide caret.
- **Focus:** The 3px tide focus outline; a field with an attached button moves the focus treatment to the wrapper.
- **Labels:** 14px/20px ink muted above the field.

### Lists and Rows
- **Row:** At least 44px, 16px left padding, item headline 17px/500 with a 14px muted meta line; a 64px tabular time column for events; a muted › chevron for rows that open.
- **Check circle:** 24px ring in a 44px target; checked fills tide with an on-tide ✓. Completed rows mute the headline; cancelled rows add a line-strong strikethrough.
- **Selection:** Selected rows take the tide-soft wash.

### Toast
Raised, 12px, the toast shadow, a tide text action on the right and a 2px tide timer bar draining along the bottom edge.

### Mini App Home
- **Heading:** the mark (cropped to its drawing, 50×27px, 12px gap, horizon on the title's baseline) beside the weekday in the Title style, with the date and how many things are left today in meta below. Faint static tide lines sit behind the heading's right side.
- **Next up:** a raised card: the time as a figure in a 64px tide-soft block, "Next up · in 2 hr 24 min" in tide, the title in Figtree, then a 4px bar that empties as the event approaches. The countdown and bar update each minute.
- **Tiles:** Today (wide: events, tasks, how many are behind you, and a segment per item), Overdue (overdue soft, with the oldest one's age) and This week (a dot under each weekday with a deadline). No deadline is the first row of My lists.
- **Quick add:** the composer as a fully round field with a fully round Add button.

### Launch
The page's first paint, before the script runs: the full lockup (mark and Figtree wordmark at the title's size) where Home's heading will appear, with "Opening your day…" and skeleton cards in Home's layout. The skeleton pulses gently and stops under reduced motion.

### All Clear
Shown once a day, when everything due and scheduled today is behind you and nothing is overdue. The mark centred over slowly drifting tide lines, "Nothing left to keep in your head today." in Figtree, and a primary **Back to Home** (Telegram's main button where available) with "See this week ›" below. Back also returns Home. The sun stays still; the lines stop under reduced motion.

### Navigation
The landing header is sticky, opaque surface with a 1px bottom line, 64px tall: lockup left, 15px muted text links that turn ink on hover, and a compact tide "Open in Telegram" button. The footer repeats the lockup with muted links.

### Thought Chip (landing page)
A half-sentence in a fully round pill: raised surface at 95%, 1px line border, 15px ink text, 40px tall, slightly tilted, resting on the soft shadow and rising 2px to the lift shadow on hover. In the field each chip bobs on its own slow loop (6-11s); on phones they scroll in two slow rows. All drift stops under reduced motion.

### Tide Lines
Faint contour lines in tide. On the landing page they animate behind the thought field and run in white over the closing tide band. In the Mini App they sit still behind Home's heading and drift slowly on the All clear screen. Always decorative and aria-hidden; never on rows, sheets or forms.

## Do's and Don'ts

### Do:
- **Do** use tide for every primary action, selected state, focus ring and "today", and nothing else.
- **Do** keep touch targets at least 44px tall and pair every status colour with a word or the ✓ symbol.
- **Do** use tabular figures for times, dates and counts.
- **Do** honour light and dark: in the Mini App, read Telegram theme colours first and fall back to the palette values.
- **Do** respect reduced motion: drifting, typing dots, the blinking caret and smooth scrolling all stop.
- **Do** use the design system's functional symbols only: ✓ completed, › opens, · separator, – range.

### Don't:
- **Don't** use marigold outside the logo, and don't animate the sun.
- **Don't** introduce a second accent colour or a gradient fill on any product surface.
- **Don't** add shadows to rows, list groups, buttons or fields; only the next-up card, Home tiles, sheets and toasts lift.
- **Don't** use Figtree for body text, rows, buttons or forms, or anywhere on the connection pages and privacy policy.
- **Don't** add decorative motion outside the landing page and the All clear screen.
- **Don't** use an icon set, decorative emoji, mascots or illustrations; symbols are functional and sparse.
- **Don't** put an uppercase eyebrow or kicker above a heading; the uppercase label style is for grouping list sections only.
