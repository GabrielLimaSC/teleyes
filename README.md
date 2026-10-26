# teleyes

**A self-hosted Telegram deal monitor: it watches the promo groups you already read, keeps only what matches your rules, and pings you privately when a price hits your target.**

[![CI](https://github.com/GabrielLimaSC/teleyes/actions/workflows/ci.yml/badge.svg)](https://github.com/GabrielLimaSC/teleyes/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
![Python 3.12+](https://img.shields.io/badge/python-3.12%2B-3776AB?logo=python&logoColor=white)
![TypeScript](https://img.shields.io/badge/typescript-React%20%2B%20Vite-3178C6?logo=typescript&logoColor=white)

![teleyes dashboard demo: live feed, product price chart, rules and dark/light theme](docs/media/demo.gif)

<!-- TODO(author): add promo video link -->

> The GIF is recorded from the [demo stack](#try-the-demo-in-one-command): every store, product, price and
> group in it is fictional. The dashboard is in Brazilian Portuguese (see [Features](#features)).

## Live demo

**[gabriellimasc.github.io/teleyes](https://gabriellimasc.github.io/teleyes/)** — the real dashboard in your
browser, no install. It is a static build with no backend: every store, product, price and group is
fictional, the dates are shifted so the data always looks fresh, a made-up offer shows up in the live feed
now and then, and every write is refused with a clear message (nothing is saved). The code that generates it
is `scripts/export_demo_fixtures.py` (data) and `apps/web/src/demo-static/` (the in-browser mock).

## Try the demo in one command

The full stack (real API, real pipeline, still 100% fictional data) on your machine. You only need Docker. No Telegram account, no bot, no secrets, no `.env`.

```bash
git clone https://github.com/GabrielLimaSC/teleyes.git
cd teleyes
docker compose -f docker-compose.demo.yml up --build
```

Open **http://localhost:18080** and sign in with the password `demo-teleyes` (it is also shown on the login
page).

- Everything is fictional: invented stores and groups, products named "... Exemplo", `example.com` links.
  A seeded script (`scripts/seed_demo.py`) builds a 90-day history through the real pipeline, so charts,
  sparklines, target pins and delivery states are populated whenever you start it.
- It is **read-only** by default: every write is refused with a clear message. A fictional offer arrives
  every 20-40 seconds so the live feed moves. To play with it, set `TELEYES_DEMO_READONLY=0`; to stop the
  incoming offers, `TELEYES_DEMO_LIVE=0`; to change the port, `TELEYES_DEMO_PORT=...`.
- There is no listener and no Telegram connection; the notifier is a no-op that never opens a network
  socket. The database lives in memory (tmpfs) and `docker compose -f docker-compose.demo.yml down` throws
  everything away.
- Demo mode refuses to start on a database with real data, and a demo database refuses to start in normal
  mode, so the public demo password can only exist next to fictional data.

## Why it exists

Telegram promo groups are full of good prices and a lot of noise: dozens of messages a day, most of them
irrelevant. Muting a group means missing the deal; leaving notifications on means drowning in them. teleyes
was built to save money while buying PC parts: it reads the groups an account can already see, keeps only
the messages that match rules written by the user, and sends a private alert through its own bot. The
matching is deliberately deterministic and explainable (plain terms, a price extractor, exact comparisons),
not an AI model guessing what a good deal is.

It is a personal, single-admin, self-hosted tool. It is not a hosted service (see
[Engineering decisions](#engineering-decisions) for why).

## How it works

```mermaid
flowchart LR
    TG["Telegram groups<br/>(MTProto user session, read-only)"] --> N[Normalization]
    N --> R["Rules<br/>include / exclude / price"]
    R -->|match| D["Deduplication"]
    R -.->|"no match: counters only"| X["Discarded<br/>(never stored)"]
    D --> DB[("SQLite, WAL")]
    DB --> API["FastAPI"]
    API -->|SSE| UI["React dashboard"]
    DB --> BOT["Bot API notifier"]
    BOT --> ME["Your Telegram chat"]
```

Two processes share one SQLite file: the **listener** (Telethon session, rules, dedup, alerts) and the
**api** (REST plus SSE for the dashboard). Docker Compose also runs a **backup** sidecar and an nginx
**web** container.

- **Rules.** A rule has include terms and optional exclude terms, compared after case and accent
  normalization. Include terms are alternatives (OR); a term written `memoria ram + 16gb` needs every part
  (AND, any order); any exclude term vetoes the match. A rule can also set a price ceiling and a price
  **target** ("alert me below"): a match at or below the target is a target hit.
- **Price extraction.** Conservative and deterministic: Brazilian formats such as `R$ 3.899,90`, `3899,90`
  or `6,991`, plus installment text. No fuzzy or ML matching.
- **Deduplication.** A signature over rule, source, normalized text, price and normalized link, so the same
  promotion reposted with different casing, tracking parameters or punctuation is recognized once. The feed
  can also group the same product and price seen in several groups.
- **Price history.** Each match is tied to a product key, which feeds the per-rule sparklines and the
  per-product price chart (lowest, average and highest over the window).
- **Delivery.** Alerts go through a separate Bot API token to recipients who were explicitly allowlisted
  after they started a chat with the bot. The bot never starts conversations.

## Features

- Live feed over SSE, with price-target cards pinned and "Apply rules" that reloads the listener without a
  restart.
- Rules with include/exclude terms, price ceiling and price target, plus a rule tester.
- Match history with filters and CSV export.
- Per-rule sparklines and a per-product price chart.
- Snooze for a product, and an optional daily digest instead of immediate alerts (target hits still alert
  immediately).
- Savings report: register what you actually bought and see an honest estimate against the prices the app itself saw
  (median of the 90 days before the purchase, "no data" when history is thin), plus a shareable results card
  (PNG + aggregates JSON) that never includes group names, messages or links.
- Retry of failed alert deliveries (recent failures are resent, never duplicated).
- Health page: listener, notifier and database state, reporting `not_configured` honestly when credentials
  are missing.
- Automatic SQLite backups, with a documented restore.
- Dark and light themes.
- Dashboard UI in Brazilian Portuguese (pt-BR). That is the current version's language, not a hard limit:
  translations (i18n) are welcome as a contribution.

## Engineering decisions

- **SQLite in WAL mode, on purpose.** One admin and a handful of writes per minute do not need Postgres or
  Redis. WAL plus `busy_timeout` lets the listener and the API share the file, and critical writes retry on
  a locked database. Backups use `VACUUM INTO`.
- **No write transaction across the network.** The alert pipeline commits its short write phase first, then
  talks to the Bot API, then writes the outcome in a second short transaction. Holding SQLite's single write
  lock across a slow network call made other writers wait and could deadlock the event loop; the comments in
  `apps/api/app/pipeline.py` and `apps/api/app/delivery_retry.py` document the fix.
- **SSE instead of polling.** The dashboard needs a one-way live stream; a single long-lived connection per
  client reconnects automatically and resumes by event id.
- **Idempotent alerts.** Dedup signatures live in the database and a delivery row is flipped only once, so a
  restart does not repeat a notification.
- **Privacy by construction.** Rejected messages are never stored, only aggregate counters and reasons.
  Matches keep the text they need, the price, the rule, the recipient, the delivery status and the original
  link.
- **Not a multi-tenant SaaS, by design.** An MTProto user session is equivalent to a full login to the
  Telegram account. Hosting other people's sessions would be an unacceptable risk, so teleyes is
  self-hosted: you run it, on your own machine, with your own account.
- **Honest states.** Without credentials the app still starts and reports `not_configured`; nothing pretends
  to be connected.

## Quick start (self-hosting)

A five-minute guide for macOS and Linux. Windows works through WSL2 (see the note below).

**You need:** [Docker](https://docs.docker.com/get-docker/) with Compose v2 (Docker Desktop on macOS/Windows,
Docker Engine on Linux), about 2 GB of free memory for Docker, and `git`. To actually monitor Telegram you
will also need Telegram API credentials and a bot token, but **not to install**: the app starts without them and the setup wizard collects them in the dashboard.

### 1. Install

```bash
git clone https://github.com/GabrielLimaSC/teleyes.git
cd teleyes
./install.sh
```

The installer checks Docker, creates a private `.env` from [`.env.example`](.env.example) (detecting your
timezone), builds and starts the stack, asks you for a dashboard password (typed without echo; only its
Argon2 hash is stored), waits for the health checks and prints the URL. The first build takes a few
minutes. Then open **http://127.0.0.1:8080** and sign in.

The stack starts in the honest `not_configured` state: the dashboard works, but nothing is read from
Telegram until step 2. Re-running `./install.sh` is safe: it keeps your `.env`, your data and your password.

Options: `--yes` (no questions; the password comes from the `TELEYES_ADMIN_PASSWORD` environment variable),
`--port 9090`, `--demo` (the fictional-data demo only), `--uninstall` (see [Uninstall](#uninstall)).

Just want to look around first? `./install.sh --demo` starts the demo stack on http://127.0.0.1:18080.

### 2. Connect Telegram (setup wizard)

Open the dashboard and follow the **setup wizard**: the banner on the Feed and Health pages leads to it
(`/configuracao`), and it resumes where you left off if you close the tab. No `.env` editing, no scripts.

1. **App credentials.** Paste the `api_id` and `api_hash` you create at <https://my.telegram.org/apps>
   (a dedicated Telegram account is recommended, because the session equals a full login).
2. **Telegram account.** Phone number, then the code Telegram sends to that account's app, then the
   two-step-verification password if it has one. The session is stored in a private volume.
3. **Alert bot.** Create a bot with [@BotFather](https://t.me/BotFather) (`/newbot`) and paste its token.
   The wizard shows the bot's `@username`, gives you a one-time link to tap **Start** (so a stranger who
   finds the bot cannot register), and can send a test message.
4. **Groups.** Pick, from the list of groups and channels the account already reads, the ones to watch.
   teleyes only reads: it never joins, replies, reacts or forwards.
5. **First rule.** Start from a template (for example "RTX 5070 up to R$ X") and finish with a live
   checklist: monitor connected, bot ok, one group, one rule.

Everything the wizard stores (API hash, bot token, session) lives in the `teleyes_session` volume with
`0600` permissions, outside the database and its backups, and is never returned by the API or written to
the logs. Reconnecting or wiping it is one button (**Desconectar Telegram**). The threat model is in
[`docs/SECURITY_SETUP.md`](docs/SECURITY_SETUP.md). Keep the dashboard private: the wizard gives whoever is
logged in full control of the connected Telegram account.

<details>
<summary>Prefer the terminal? The manual path still works</summary>

1. Create the API credentials and a bot as above, open your bot and send `/start`.
2. Put `TG_API_ID=`, `TG_API_HASH=` and `BOT_TOKEN=` in `.env` (values there win over the wizard's).
3. Log the reading session in; it asks for your phone, the code and your 2FA password in the terminal:

   ```bash
   docker compose run --rm --entrypoint python listener scripts/telegram_login.py
   ```

4. `docker compose up -d`, then register a source group, a recipient and a rule in the dashboard and click
   **Aplicar regras**.

</details>

The session lives in its own Docker volume (`teleyes_session`), separate from the database, so restoring a
backup never touches your Telegram login.

### Which compose file?

`docker-compose.yml` is the supported way to run teleyes; `install.sh` drives it. `docker-compose.prod.yml` is
the author's own 24/7 deployment (different volume names, behind Tailscale Serve) and is kept as is; strangers
should ignore it. `docker-compose.dev.yml` is a hot-reload stack for contributors.

### Troubleshooting

| Symptom | Fix |
|---|---|
| `Docker is not installed` | Install Docker Desktop or Docker Engine: <https://docs.docker.com/get-docker/> |
| `the daemon is not running` | Start Docker Desktop and wait until it says it is running. On Linux: `sudo systemctl start docker`, and add your user to the `docker` group (`sudo usermod -aG docker $USER`, then log in again). |
| `Docker Compose v2 is missing` | Update Docker Desktop, or install the plugin: <https://docs.docker.com/compose/install/> |
| `Port 8080 is already in use` | Use another port: `./install.sh --port 9090` (it is remembered in `.env`). |
| Build killed, `exit 137`, or `npm` dies | Docker is out of memory. Docker Desktop: Settings > Resources > Memory, set 2 GB or more, then re-run `./install.sh`. |
| Times look wrong | Set `DISPLAY_TIMEZONE=Your/Zone` in `.env` (IANA name, e.g. `Europe/Lisbon`), then `docker compose up -d`. Stored timestamps are always UTC. |
| Login works in Chrome but not in Safari | Keep `SESSION_COOKIE_SECURE=false` in `.env` for plain `http://127.0.0.1`; set it to `true` only behind HTTPS. |
| Dashboard unreachable right after `up` | `docker compose ps` should show `api` and `web` as `healthy`; look at `docker compose logs api web`. |
| Telegram says `not_configured` | Expected until the setup wizard (step 2) is done. If you configured through `.env`, run `docker compose up -d` to apply it. |
| Forgot the dashboard password | `docker compose exec api python scripts/create_admin.py` sets a new one. |

**Windows:** install Docker Desktop with the WSL2 backend, open a WSL2 shell (Ubuntu), clone the repository
**inside the Linux filesystem** (for example under `~/`, not `/mnt/c/...`) and run `./install.sh` there.
Then browse to http://127.0.0.1:8080 from Windows.

### Updating

```bash
cd teleyes
git pull
docker compose up -d --build
```

Migrations run automatically when the `api` container starts, and your volumes are untouched. If an update
changes `.env.example`, compare it with your `.env` and add any new variable you want.

### Backups and restore

The `backup` service copies the SQLite database every 6 hours (`BACKUP_INTERVAL_SECONDS`) into the
`teleyes_backups` volume and keeps the newest 28 (`BACKUP_RETENTION_COUNT`). One extra backup right now:

```bash
docker compose run --rm --no-deps --entrypoint python backup scripts/run_backup.py --once
```

To restore (never overwrite the database while `api` and `listener` are writing to it):

```bash
docker compose run --rm --no-deps --entrypoint sh backup -c "ls -la /app/backups"   # pick a file
docker compose stop api listener
docker compose run --rm --no-deps --entrypoint sh backup -c "rm -f /app/data/teleyes.db-wal /app/data/teleyes.db-shm && cp /app/backups/teleyes-<timestamp>.db /app/data/teleyes.db"
docker compose up -d
```

The Telegram session is not in the backup (it is a credential, in its own volume). To copy backups off the
machine, use `docker cp` from a container that mounts `teleyes_backups`, or a bind-mounted copy job.

### Uninstall

```bash
./install.sh --uninstall           # asks first; removes the containers, keeps your data
./install.sh --uninstall --purge   # also deletes the database, the Telegram session and the backups
```

Both keep your `.env`; delete it yourself when you no longer need it. Log out of the session in Telegram
(Settings > Devices) if you are done with it for good.

Environment variables are documented one by one in [`.env.example`](.env.example). The deeper operational
guide (diagnostics, Windows boot automation, the author's production setup) is in
[`docs/OPERATIONS.md`](docs/OPERATIONS.md), written in Portuguese.

## Security

- Remote access is meant to go through Tailscale Serve (private HTTPS); the app is not designed to be
  exposed to the public internet.
- Dashboard login uses an Argon2 password hash and a server-side session in an HttpOnly, Secure,
  SameSite cookie. Configuration endpoints never return a secret in full.
- The Telegram session file, API hash and bot token must never reach Git, logs, screenshots or issues.
- The Telegram client is read-only: it never replies, reacts, joins groups or forwards messages.

Details and how to report a vulnerability privately: [SECURITY.md](SECURITY.md).

## Tests and quality

Numbers from a run on 2026-10-21 against a fresh install:

| Check | Result |
|---|---|
| `pytest` | 804 tests passed |
| `ruff check .` | clean |
| `mypy .` | clean (170 source files) |
| `npm run test` (Vitest) | 607 tests passed |
| `npx tsc -b` | clean |
| `npm run lint` (Oxlint) | runs; a few existing React warnings, no errors |
| Playwright (`npm run test:e2e`) | 139 tests in 29 files; run locally against a real backend, not in CI yet |

GitHub Actions runs ruff, mypy, pytest, tsc, Oxlint and Vitest on every push and pull request to `dev` and
`main` ([workflow](.github/workflows/ci.yml)).

```bash
# Backend (Python 3.12+)
python3.12 -m venv .venv && .venv/bin/pip install -e ".[dev]"
.venv/bin/pytest && .venv/bin/ruff check . && .venv/bin/mypy .

# Frontend
cd apps/web && npm ci && npm run test && npx tsc -b && npm run lint
```

## Tech stack

- **Backend:** Python 3.12, FastAPI, Telethon (MTProto), SQLAlchemy 2, Alembic, SQLite (WAL), Argon2.
- **Frontend:** React, Vite, TypeScript, Server-Sent Events.
- **Ops:** Docker Compose (`api`, `listener`, `backup`, `web`) with a one-command `install.sh`, nginx, Tailscale Serve for private access.
- **Quality:** pytest, Ruff, mypy, Vitest, Oxlint, Playwright, GitHub Actions.

## Roadmap

Honest and undated:

- A savings report built from price history.

Out of scope for now: multi-tenant use, channels other than Telegram, automatic replies or reactions in
groups, public exposure, and fuzzy or ML matching.

## Contributing and license

Contributions are welcome; read [CONTRIBUTING.md](CONTRIBUTING.md) first and open an issue before anything
large. More context: [PRODUCT.md](PRODUCT.md), [DESIGN.md](DESIGN.md), [docs/PROJECT_SPEC.md](docs/PROJECT_SPEC.md).

Released under the [MIT License](LICENSE).
