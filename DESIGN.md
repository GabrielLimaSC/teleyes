---
name: teleyes
description: Personal Telegram promotion monitor — a calm liquid-glass Operate console for one admin.
colors:
  page-bg: "#f5f5f7"
  ink: "#08060d"
  ink-muted: "#4b4b52"
  capsule-bg: "rgba(232, 234, 239, 0.42)"
  capsule-tab-inactive: "#4b4b52"
  glass-surface: "rgba(255, 255, 255, 0.6)"
  glass-edge-top: "rgba(255, 255, 255, 0.8)"
  glass-edge: "rgba(255, 255, 255, 0.4)"
  border-hairline: "rgba(0, 0, 0, 0.12)"
  danger: "#b3261e"
  danger-bg: "#fbe4e2"
  success: "#1c8a4b"
  success-bg: "#e2f5e9"
  warning: "#8a6d00"
  warning-bg: "#fbf1d6"
  indigo: "#3f3fb0"
  indigo-bg: "#e9e9fb"
  neutral-status: "#4b4b52"
  neutral-status-bg: "#ececef"
  aurora-violet: "#a35bfb"
  aurora-blue: "#5b8dfb"
  aurora-pink: "#fb5ba0"
  aurora-mint: "#4ce8a8"
  category-phone: "#e3ecfb"
  category-laptop: "#ece3fb"
  category-headphones: "#fbeee3"
  category-gaming: "#fbe3ef"
  category-generic: "#e9e9ec"
typography:
  display:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"
    fontSize: "32px"
    fontWeight: 700
    lineHeight: 1.2
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"
    fontSize: "22px"
    fontWeight: 700
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.4
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 500
rounded:
  pill: "999px"
  card: "20px"
  icon-square: "14px"
  input: "10px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "20px"
  xxl: "24px"
components:
  button-primary:
    backgroundColor: "#171717"
    textColor: "#ffffff"
    rounded: "{rounded.pill}"
    padding: "10px 18px"
  button-primary-hover:
    backgroundColor: "#171717"
  button-ghost:
    backgroundColor: "#ffffff"
    textColor: "{colors.ink-muted}"
    rounded: "{rounded.pill}"
    padding: "6px 12px"
  nav-pill-active:
    backgroundColor: "#171717"
    textColor: "#ffffff"
    rounded: "{rounded.pill}"
  nav-tab-inactive:
    backgroundColor: "transparent"
    textColor: "{colors.capsule-tab-inactive}"
---

# Design System: teleyes

## Overview

**Creative North Star: "The Quiet Console"**

teleyes is a one-admin instrument panel for a personal Telegram promotion monitor: liquid glass in
daylight, never a nightclub. The world is Apple's "liquid glass" material — a light, almost-white
canvas (`#f5f5f7`) holding frosted, translucent surfaces — applied in **Operate** mode: the interface's
job is to let Gabriel scan a live feed, edit rules, and check system health quickly, never to perform for
an audience. Every screen is real: real login, real CRUD, real SSE feed, real (or honestly `not_configured`)
notification delivery. Nothing on screen is decoration standing in for a feature that doesn't exist yet.

Legibility is a stated, non-negotiable acceptance criterion, not a preference: product name and price are
always the darkest, heaviest thing in a row; source, rule, and other metadata recede in weight and color.
Status is never color alone — every status pill carries a dot **and** a word. The floating silver navigation
capsule uses genuine SVG backdrop displacement at its edge, a dark active tab, and a compact drawer on
small screens. It is the one piece of chrome Gabriel looks at on every screen; everything downstream of
it stays calm so the material remains legible.

**Key Characteristics:**
- Light liquid-glass surfaces on an off-white canvas, never a dark theme.
- A floating silver capsule is the navigation landmark; its dark active tab carries the emphasis.
- Weight and color encode hierarchy (product/price bold+dark, metadata light+gray) — never size alone.
- Status is always a dot plus a word, never a color chip by itself.
- Motion is confined to specific, purposeful moments (mobile drawer, page transition, button fill) and fully
  disabled under `prefers-reduced-motion` — it is never ambient or decorative.

## Colors

The palette is almost monochrome by design — near-white surfaces, near-black text — with color spent on
status/category accents and the restrained blue-violet focus treatment.

### Primary
- **Ink** (`#08060d`): the strongest neutral for product names, prices, and page titles. Reserved for
  what the eye must land on first in any row.

### Neutral
- **Page Canvas** (`#f5f5f7`): the app's background on every page; never pure white, so the glass
  surfaces have something to float above.
- **Aurora Wash** (three radial gradients — blue `rgba(91, 141, 251, 0.16)`, violet
  `rgba(163, 91, 251, 0.14)`, pink `rgba(251, 91, 160, 0.1)` — anchored top-left, top-right, and
  bottom-center, on a fixed `body::before` layer, `z-index: -1`): without something varied behind them,
  the glass cards' `backdrop-filter: blur()` has nothing to blur and the signature material reads as a
  plain translucent white rectangle rather than "glass". The wash exists purely to make that material
  legible at rest; it never carries meaning and stays subtle enough to leave every text contrast ratio
  in the system unaffected (S4-09 finish pass).
- **Muted Ink** (`#4b4b52`): every secondary/metadata string — form labels, table headers, match
  metadata, health-panel labels. Chosen specifically to clear 4.5:1 contrast against both the page
  canvas and white card surfaces (`#7a7a82`, the first color tried here, measured 3.91–4.26:1 and was
  replaced during S4-08's accessibility pass).
- **Silver Glass** (translucent cool neutrals around `rgba(232, 234, 239, 0.42)`): the navigation
  capsule and mobile drawer, with a bright top edge and subtle lower shadow.
- **Action Black** (`#171717`): the active nav tab and primary actions.
- **Tab Gray** (`#4b4b52`): inactive nav labels on the silver capsule.

### Named Rules (optional, powerful)
**Dark for action.** The active nav tab and primary buttons carry opaque near-black fills. The capsule
itself remains translucent silver, so the current destination is clear without darkening the whole shell.

### Status & Category Accents
Status pills and category-icon tiles are the only saturated color in the system, and both follow the
same construction: a pale tint background (`*-bg`) with a fully-saturated foreground/dot of the same hue
family, so text stays legible and the dot stays identifiable at a glance.
- **Success** (`#1c8a4b` on `#e2f5e9`): a delivery that actually sent.
- **Danger** (`#b3261e` on `#fbe4e2`): a failed delivery or a destructive action (delete buttons, error text).
- **Warning** (`#8a6d00` on `#fbf1d6`): not-yet-connected/not-allowlisted states — "attention", not "broken".
- **Indigo** (`#3f3fb0` on `#e9e9fb`): the deliberately calm "notification disabled" state — distinguished
  from Danger on purpose, because no `BOT_TOKEN` is a configuration fact, not a failure.
- **Category tiles** (`#e3ecfb` blue / `#ece3fb` violet / `#fbeee3` peach / `#fbe3ef` pink / `#e9e9ec`
  neutral gray): purely decorative sorting cues on the Feed/Histórico cards — the hue carries no status
  meaning, only "these two rows are probably the same kind of thing".
- **Aurora Glow** (`#5b8dfb` → `#a35bfb` → `#fb5ba0` → `#4ce8a8`, conic gradient): reserved for the single
  match that is the lowest price a rule has ever seen. No real data can trigger it yet (price history is
  backlog); the ring exists, tested, waiting for that field.

## Typography

**Display/Body Font:** system UI stack (`-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui,
sans-serif`) — no webfont is loaded. "Grotesk" in the approved direction is honored through the system
sans on every platform (SF on Apple devices) rather than a shipped font file, keeping the app fast and
license-free for a single-admin tool.

**Character:** Plain, high-legibility, weight-driven hierarchy — the type system does almost all of its
work through **bold vs. regular** and **dark vs. muted**, not through a wide size scale.

### Hierarchy
- **Display** (700, 32px, 1.2): page titles ("Feed ao vivo", "Regras", "Saúde", …) — one per page.
- **Title** (700, 22–24px): section headers inside a page (the login card's "teleyes", the
  "Destinatários" sub-section heading on Regras).
- **Product** (700, 17px, `{colors.ink}`): a match's product line — always the heaviest text in its card.
- **Price** (700, 18px, `{colors.ink}`): always bold and dark, matching Product's weight so the two
  numbers a user actually needs — what and how much — read at the same authority.
- **Body** (400, 14px): form inputs, buttons, table cells.
- **Label** (500, 13px, `{colors.ink-muted}`): metadata lines, table headers, form field labels — always
  the muted color, never competing with Product/Price.

### Named Rules (optional)
**The Two-Weight Rule.** A row never needs a third font size to read correctly: what matters is bold and
dark, what's context is regular and muted. If a new field needs its own size to stand out, it's fighting
the hierarchy instead of using it.

## Layout

Every page shares one shell: the navigation capsule at the top (see Components → Navigation), then
a single content column, `max-width: 640–900px` depending on the page's density (760px for card lists
like Feed/Histórico, 900px for the wider CRUD tables on Regras/Fontes, 640px for the single-column Saúde
panel), centered with side padding that never lets content touch the viewport edge. There is no sidebar
anywhere in the system — this is a stated rejection from the approved direction, not an omission.

**Responsive behavior:** at ≤760px the navigation capsule presents a compact bar and an expandable
two-column drawer for its six tabs, with no page-level horizontal scroll at 390–400px.
CRUD tables (Regras/Fontes/Destinatários) get their own horizontal scroll container
(`overflow-x: auto` on a `.crud-table-wrap`, not the page) below that width, so a wide table degrades by
scrolling in place rather than forcing the whole page to scroll sideways or truncating columns silently.
Filter forms (Histórico) and CRUD forms stack to a single column below 640px via `grid-template-columns:
repeat(auto-fit, minmax(180px, 1fr))`.

## Elevation & Depth

The system is a **hybrid**: mostly flat, tonal layering (a card is simply a lighter, blurred rectangle on
the page canvas), with exactly one real shadow vocabulary reserved for the two elements that need to read
as floating above everything else.

### Shadow Vocabulary
- **Capsule float** (two soft layers, `0 18px 32px rgba(23, 23, 23, 0.13)` and
  `0 4px 10px rgba(23, 23, 23, 0.09)`): the silver navigation capsule.
- **Glass lift** (`box-shadow: 0 8px 32px rgba(15, 15, 20, 0.08)`): every glass card (match cards, form
  panels, CRUD table containers) — a much softer lift than the capsule's, keeping cards feeling like they
  rest on the canvas rather than float above it.

### Named Rules (optional)
**Depth planes.** The capsule floats above the page; cards lift more softly. A new surface should join
one of these planes rather than invent another elevation level.

## Shapes

Corners are large and consistently pill-or-rounded, never sharp: **20px** on every glass card, **999px**
(true pill) on the navigation capsule, every button, every status pill, and the pause/active toggle;
**14px** on category-icon squares (a smaller, secondary radius so icon tiles read as "inside" a card
rather than as their own card); **10–12px** on form inputs and selects. Borders are hairline and low
alpha (`rgba(0, 0, 0, 0.12)` on inputs and CRUD-table action buttons) or omitted entirely in favor of the
glass surface's own soft top-edge highlight (`border-top-color: rgba(255, 255, 255, 0.8)` on
`.glass-card`) — teleyes never uses a hard, fully-opaque border as its primary surface delimiter.

## Components

### Buttons
- **Shape:** true pill (`border-radius: 999px`).
- **Primary** (`.crud-page__new-button`, `.crud-form__submit`, the login submit, "Enviar teste"):
  near-black fill, white text, `10px 18px` padding.
  - **Interaction — color fill from the click point:** every primary button also carries `.fill-button`
    (`FillButton.css`): a translucent white bloom (`rgba(255, 255, 255, 0.18)`) expands from wherever the
    pointer went down (`--fill-x`/`--fill-y`, set by `useFillOrigin()`), via `clip-path: circle()`
    animating 0%→150% over 480ms on an ease-out-expo-flavored curve. Disabled under
    `prefers-reduced-motion`.
- **Ghost** (`.crud-form__cancel`, table row actions "Editar"/"Duplicar"/"Testar"): white fill, hairline
  border, `{colors.ink-muted}` text, `6–8px` vertical padding.
- **Danger ghost** ("Excluir"): same ghost shape, `{colors.danger}` text and a low-alpha danger border —
  color is the only differentiator from a normal ghost button, since delete is always paired with the
  word "Excluir" itself, never an icon-only trash button.
- **Disabled:** an explicit gray fill (`#c7c7cc` background, `#6b6b70` text, `cursor: not-allowed`) on
  primary submit buttons with an unmet precondition (empty password, no recipient selected), rather than
  dimming the resting fill with opacity — a flat gray reads as "not clickable" at a glance where an
  opacity-dimmed dark pill can still look pressable in a static screenshot (S4-09 finish pass).

### Status Pill
- **Style:** pill shape, pale tint background, saturated dot (8px circle) + saturated text of the same
  hue, `6px 14px` padding.
- **The Dot-and-Word Rule.** No status anywhere in the system is color-only: `summarizeDeliveryStatus`,
  `telegramStateLabel`/`botStateLabel`, and the SSE `connecting`/`open`/`error` states all resolve to a
  `{label, color}` pair rendered as dot + word together, never a bare colored chip.

### Cards / Containers (Glass Card)
- **Corner Style:** 20px.
- **Background:** `rgba(255, 255, 255, 0.6)`, `backdrop-filter: blur(20px)`.
- **Border:** 1px `rgba(255, 255, 255, 0.4)`, with the top edge brightened to `rgba(255, 255, 255, 0.8)`
  for the "light hitting frosted glass from above" cue the approved direction asked for.
- **Shadow Strategy:** Glass Lift (see Elevation).
- Used for: match cards, CRUD create/edit form panels, CRUD table containers, the Saúde health/test panels,
  the login card.

### Match Card (signature)
The Feed/Histórico row: a category-icon tile (colored square, 56px, line-art SVG glyph) on the left, then
product (bold) over metadata (muted, "Fonte: … · Regra: … · Para: …") in the middle, price (bold, right
of center), the status pill, and — only when `isLowestPriceEver` is true — the Aurora Glow ring around
the whole card plus a small "Menor preço já visto" label. Wraps to two lines below 720px (icon+product
row, then price+status row) rather than shrinking text.

### Inputs / Fields
- **Style:** 10px radius, hairline border, white or near-white (`rgba(255,255,255,0.7)` on the login
  card) fill.
- **Label:** always a real `<label>` wrapping the control (never a placeholder standing in for a label).
- **Error:** a `role="alert"` paragraph in `{colors.danger}` directly below the form, carrying the
  backend's actual error `detail` string, never a generic "something went wrong".

### Navigation (signature)
The desktop capsule is a 720px maximum silver glass pill with six legible links visible at rest. Three
tabs sit on each side of the existing mascot slot. The active destination is a near-black pill with white
text; inactive links use muted ink and gain a pale highlight on hover. The mascot image and its own glass
treatment remain independent of the navigation material.
- **Material:** the silver tint, bright rim, and soft shadow frame a backdrop layer. An SVG
  `feDisplacementMap` refracts the actual backdrop near the top and bottom edges. The plain blur
  declaration is the fallback where SVG backdrop filters are unavailable. The displacement is subtle on
  the nearly flat page wash but measurable when a patterned backdrop passes behind the bar.
- **Compact layout:** at ≤760px the bar shows the product name, current route, and the mascot control.
  The six links occupy a two-column glass drawer when the mascot opens it. The drawer stays within 400px
  without horizontal scrolling and closes after route selection or Escape.
- **Semantics:** desktop links are directly available by keyboard; the desktop mascot is decorative.
  In compact layout the mascot exposes `aria-expanded` and `aria-controls`, and a live status names the
  current route while the drawer is closed.
- **Motion:** the compact drawer enters with restrained opacity and transform. Reduced-motion preference
  removes those transitions. Page transitions outside the navbar keep their existing route behavior.

## Do's and Don'ts

### Do:
- **Do** keep product and price the darkest, boldest thing in any row — metadata is always
  `{colors.ink-muted}`, never `{colors.ink}`.
- **Do** pair every status indicator with a word, never ship a bare colored dot or chip.
- **Do** wrap every new primary CTA in `.fill-button` and call `useFillOrigin()` on `onPointerDown`, so
  the click-fill motion stays consistent everywhere buttons commit an action.
- **Do** guard every new motion (transition, animation, animated SVG filter) with a
  `prefers-reduced-motion: reduce` override that removes it, not just shortens it.
- **Do** surface the backend's real error `detail` string in `role="alert"` text — never a generic
  fallback when the API already told you what went wrong.

### Don't:
- **Don't** spread opaque dark fills beyond the active navigation state and primary actions; the silver
  capsule should remain the navigation landmark.
- **Don't** invent a new elevation plane without a functional reason.
- **Don't** fabricate data a real field doesn't back: the category icon, the "Último match" column, and
  the Aurora Glow trigger are all explicitly either cosmetic-only or held inert until real data exists —
  follow that same discipline for any new derived or decorative field.
- **Don't** use a bounce/elastic easing curve (`cubic-bezier` with any value outside `[0, 1]`) anywhere;
  the compact drawer uses a smooth exponential deceleration.
