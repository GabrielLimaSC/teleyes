# Changelog

All notable changes to teleyes are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [1.0.0] - unreleased

First stable release: a self-hosted Telegram deal monitor you can install with one command.

### Added

- One-command self-hosted install (`install.sh`) and a guided in-dashboard setup wizard for the Telegram
  credentials, account login, alert bot, groups and a first rule.
- A guided first run ("Comece por aqui"), helpful empty states, first-time tips and plain-language help for
  the main concepts.
- Rule templates, a simple and an advanced rule mode, and a live preview of what a rule would have matched.
- Recipient per rule, per-recipient delivery preferences and a daily digest ("Resumo diário").
- Savings report ("Economia") with purchases, a savings goal, a user-supplied reference price and a shareable
  results card that never includes group names, messages or links.
- Health screen with hourly collector metrics, service heartbeat and an event log; Groups screen with 7-day
  activity.
- Persistent sessions ("Manter conectado").
- A public static demo on GitHub Pages and a one-command Docker demo, both with fictional data only.
- CI: production web build, Docker image builds and a Playwright smoke run against a real backend.
- `CHANGELOG.md` and a documentation index (`docs/README.md`).

### Changed

- The rules and notifications code moved into the standalone `teleyes-core` library (`core/`), which stays at
  `0.1.0` until its public API settles; the application and the web client are versioned `1.0.0`.
- Redesigned dashboard (v2): Ofertas, Regras, Grupos, Economia, Saúde and login, with day-to-day wording
  instead of internal jargon.
- The API reports version `1.0.0` on `/health`, shown on the Saúde screen and the login page.

### Removed

- The obsolete `scripts/run_pipeline_demo.py` manual demo script, replaced by the setup wizard and the demo
  stack.

### Security

- A pre-1.0 security audit with fixes; see [docs/SECURITY_AUDIT.md](docs/SECURITY_AUDIT.md).
- Hardened container images (unprivileged nginx on a current stable line, patched Alpine packages).
- Secrets entered in the wizard are stored in a separate private volume, outside the database and backups,
  and are never returned by the API or written to logs.

### Accessibility

- WCAG 2.2 level AA on every screen, in both themes, from 390 px to 1440 px, verified by an automated axe
  audit and keyboard end-to-end specs; see [docs/ACCESSIBILITY.md](docs/ACCESSIBILITY.md).

## [0.x] - 2026

Pre-release history, summarized.

- **Core pipeline:** Telethon read-only listener, deterministic rules with conservative Brazilian price
  extraction, deduplication, SQLite in WAL mode, SSE live feed and a private Bot API notifier with idempotent
  delivery and retry of failed alerts.
- **Rules and prices:** price ceiling and target, `+` for all-words terms, rule tester over history, product
  identity and price history, snooze and delivery policy, manual product correction with an audit trail.
- **Dashboard:** feed, history with CSV export, rules, sources, health, dark and light themes, responsive
  layout and a product panel with a price chart.
- **Operations:** Docker Compose stack with automatic backups, documented restore and Tailscale-ready
  deployment.
- **Open source preparation:** repository hygiene, README, issue and pull request templates, demo mode with
  fictional data and a static public demo.
