# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Delegated: React, Vite and TypeScript for a responsive web interface. The backend uses Python, FastAPI,
Telethon and SQLite. The choice favors a small deployable system and direct Telegram MTProto support.

## Users

Gabriel is the primary user and administrator. He connects the Telegram reader, chooses monitored groups,
creates rules, inspects results and configures notification recipients.

Gabriel's girlfriend is initially a notification recipient, not a dashboard account. Gabriel can create
rules for her and choose whether an alert goes to him, to her or to both. A second dashboard account is a
future option, not a v1 requirement.

## Product Purpose

Teleyes lets Gabriel mute high-volume promotion groups without losing time-sensitive offers. It watches
messages his Telegram account can already access, keeps only relevant matches and sends a prompt private
Telegram notification. Success means a useful offer is identified, deduplicated, recorded and delivered
within seconds while irrelevant traffic remains silent.

## Positioning

Teleyes combines private-account group access, rule-based filtering, deduplication, price awareness and a
real-time personal dashboard. The system is designed for the user's existing closed or public promotion
groups rather than only channels accessible to a third-party public bot.

## Operating Context

The service runs continuously on Gabriel's home desktop. Gabriel primarily receives alerts on his phone
and opens the dashboard from phone or desktop through a private Tailscale connection. Promotion groups
remain muted; the Teleyes alert-bot conversation remains enabled for notifications.

## Capabilities and Constraints

- Rules contain positive terms, alternatives, blocked terms, optional maximum price, selected source
  groups, recipient and deduplication window.
- A Telethon/MTProto user session reads groups; a separate BotFather bot sends incoming alert messages.
- The dashboard contains login, live feed, rules, sources, history and system-health/settings surfaces.
- The feed updates through SSE and provides source, timestamp, extracted price, matching rule, delivery
  status and a link to the original Telegram message when available.
- Only matched messages are retained. Rejected traffic contributes aggregate counters without retaining
  message content.
- Reconnection includes bounded backfill so brief outages do not silently lose offers.
- Telegram session files, API hash, bot token and passwords never enter Git.
- WhatsApp notifications, public multi-tenant hosting and automatic Telegram replies/reactions are outside
  v1.

## Brand Commitments

The confirmed product name is **teleyes**. Product language is pt-BR, direct and factual. It must not
present itself as an official Telegram product or visually imitate Telegram.

## Evidence on Hand

No brand assets, customer claims or production data exist yet. Interface examples must be labeled as
demonstration data and must not invent savings, reliability rates or market adoption.

## Product Principles

- Alert quickly, explain why it matched and link to the source.
- Prefer silence over noisy low-confidence alerts.
- Keep the deployment small enough to run unattended at home.
- Make health and disconnection visible before failures become silent.
- Minimize retained third-party message content.

## Accessibility & Inclusion

The web interface must be keyboard accessible, responsive for phone and desktop, compatible with reduced
motion, and must not encode delivery/match state by color alone.
