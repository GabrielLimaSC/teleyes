# Documentation index

| Document | What it covers |
|---|---|
| [Setup security](SECURITY_SETUP.md) | Threat model of the in-dashboard Telegram setup wizard and where secrets live. |
| [Security audit](SECURITY_AUDIT.md) | The pre-1.0 security review: what was checked, found, fixed and left alone, and how to re-run it. |
| [Accessibility](ACCESSIBILITY.md) | WCAG 2.2 AA target, the automated axe audit, keyboard coverage and known limits. |
| [Manual setup validation](SETUP_MANUAL_VALIDATION.md) | Checklist to prove the setup wizard against real Telegram with a test account. |
| [Operations runbook](OPERATIONS.md) | Diagnostics, backups, Windows boot automation and the author's 24/7 setup (pt-BR). |
| [Project specification](PROJECT_SPEC.md) | The original product and architecture specification (pt-BR). |

Elsewhere in the repository:

- [`README.md`](../README.md): overview, quick start and the demo.
- [`SECURITY.md`](../SECURITY.md): supported versions and private vulnerability reporting.
- [`CONTRIBUTING.md`](../CONTRIBUTING.md): setup and the checks to run before a pull request.
- [`CHANGELOG.md`](../CHANGELOG.md): what changed in each release.
- [`PRODUCT.md`](../PRODUCT.md) and [`DESIGN.md`](../DESIGN.md): product principles and the design system.
- [`core/`](../core/): the standalone `teleyes-core` library (rules, price extraction, notifications).

Architecture in one picture is in the README section "How it works"; the decisions behind it
("Engineering decisions") are in the same file. Screenshots in [`screenshots/`](screenshots/) and the demo GIF in
[`media/`](media/) are recorded from the fictional-data demo stack.
