# Security audit (S23-01)

A security review of teleyes ahead of 1.0, done on 2026-11-04 against the `dev` branch
(after the `core/` split). It combines automated scanners with a manual review of the parts
that matter for a tool that holds a Telegram user session. This page says what was checked,
what was found, what was fixed, what was knowingly left alone, and how to run it all again.

The threat model is the one in [`SECURITY.md`](../SECURITY.md) and
[`docs/SECURITY_SETUP.md`](SECURITY_SETUP.md): a single administrator, a self-hosted instance
reachable only on a private network (for example Tailscale Serve), and a hostile Telegram group
as the main source of untrusted input (every message text, title and link comes from strangers).

## Summary

| Severity | Found | Fixed | Accepted |
|---|---|---|---|
| Critical | 0 | 0 | 0 |
| High | 0 | 0 | 0 |
| Medium | 5 | 5 | 0 |
| Low | 6 | 4 | 2 |
| Informational | 6 | 0 | 6 |

No real secret was ever committed, no scanner found a Python dependency vulnerability in the
runtime images, and every state-changing route already required a session and a CSRF token.
The Medium findings were missing hardening (CSP and headers, root containers), a token that
could reach a traceback, CSV formula injection and four advisories in a transitive dependency.

## Scope and tools

In scope: the API (`apps/api`), the packages (`packages/`, `core/`), the scripts, the web app
(`apps/web`), the Docker images and Compose files, and the git history (all branches).
Out of scope: Telegram itself, Tailscale, the host operating system and the static GitHub
Pages demo (it holds only fictional data and cannot set response headers).

| Check | Tool and version | Command |
|---|---|---|
| Python dependencies | pip-audit 2.10.1 | `pip-audit -r constraints-ci.txt --no-deps --disable-pip` |
| npm dependencies | npm 11.11.0 | `npm audit --omit=dev` and `npm audit` (in `apps/web`) |
| Secrets in history | gitleaks 8.30.1 | `gitleaks detect --source . --redact` |
| Python code | bandit 1.9.4 | `bandit -r apps/api packages scripts core/src -ll -x <tests>` |
| Code patterns | semgrep 1.183.0, packs `p/python`, `p/typescript`, `p/react` | see below |
| Container images | Trivy 0.76.1 (`aquasec/trivy` image) | `trivy image --severity CRITICAL,HIGH --scanners vuln <image>` |
| Behaviour | pytest, Vitest, Playwright 1.63 with Chromium | see below |

## Findings

### Medium

**M1. Missing security headers and Content-Security-Policy on the dashboard.** The production
nginx (`docker/web-nginx.conf`) sent no CSP, no `X-Content-Type-Options`, no framing protection
and no `Referrer-Policy`, and advertised its version. *Fixed:* every response now carries a CSP
built from what the app really loads (its own origin, one hash-pinned inline theme script,
Inter from Google Fonts, same-origin `fetch` and SSE), `X-Content-Type-Options: nosniff`,
`X-Frame-Options: DENY` plus `frame-ancestors 'none'`, `Referrer-Policy: no-referrer`,
a restrictive `Permissions-Policy`, `Cross-Origin-Opener-Policy` and
`Cross-Origin-Resource-Policy`, `server_tokens off` and a 256 KiB body cap. Verified in a real
Chromium against the built image: login, feed, rules, sources, history, savings, health and
setup render with zero CSP violations and the fonts load.
`apps/web/src/securityHeaders.test.ts` reads the nginx config and also recomputes the hash of
the inline script, so editing that script fails the test with a pointer to the new value.

**M2. Containers ran as root.** All three Python services and nginx ran as uid 0. *Fixed:* the
API image has an unprivileged `teleyes` user (uid 10001). Each entrypoint starts as root only to
hand the volumes to that user (`docker/as-teleyes.sh`, which also migrates volumes written by
older root images) and then drops privileges with `setpriv`; verified in the running containers
(`Uid: 10001`, `NoNewPrivs: 1`, `/app/data` and `/app/session` `0700`, database `0600`). The web
image is now `nginx-unprivileged` (uid 101, port 8080); the host-side port mapping is unchanged.
Compose adds `no-new-privileges`. `test_docker_hardening.py` guards the configuration.

**M3. CSV formula injection in the history export.** Product titles come from Telegram messages,
and a title like `=HYPERLINK(...)` ran as a formula when the exported CSV was opened in a
spreadsheet. *Fixed:* `apps/web/src/utils/csv.ts` prefixes a cell starting with `=`, `+`, `-`,
`@`, a tab or a carriage return with `'`. Unit tests cover each trigger and the quoting rules.

**M4. The bot token could appear in an exception.** `HttpBotClient` called
`raise_for_status()`, and the resulting `httpx` error message contains the request URL, which
contains the bot token. The scheduling code logs only the exception class, but an uncaught
error (for example from a request handler) is printed as a full traceback. *Fixed:* a failed
`sendMessage` now raises `BotSendError`, carrying only the HTTP status, raised `from None`. The
token is also percent-encoded into the URL (no host or path smuggling, so no SSRF through a
hostile value) and redirects are not followed. Tests cover the status error, the network error
and a hostile token.

**M5. Four advisories in `pyasn1` 0.6.4** (a transitive dependency of Telethon through `rsa`),
fixed in 0.6.5. *Fixed:* `constraints-ci.txt` pins 0.6.5. The Docker image installs unpinned, and
Trivy found no vulnerable Python package in it.

### Low

**L1. Login throttling was short and had no feedback.** The limiter existed (5 failures per
minute, fixed 60 s lock) but gave a bare English 429. *Fixed:* 5 failures in 5 minutes lock the
login for 60 s, each repeat doubling up to 15 minutes; the 429 carries a Portuguese message and
a `Retry-After` header, and the login form shows the wait. An unknown administrator takes the
same work and returns the same 401 as a wrong password, and passwords over 1024 characters are
refused before hashing. Tests: `test_security_hardening.py`.

**L2. No ceiling on request bodies.** Pydantic models accept unbounded strings. *Fixed:* a pure
ASGI middleware (`apps/api/app/body_limit.py`) answers 413 for any body over 256 KiB, whether or
not it declares a `Content-Length`; nginx caps it as well.

**L3. `HEARTBEAT_URL` accepted any URL scheme (bandit B310).** `urlopen` also speaks `file://`
and `ftp://`. *Fixed:* only `http` and `https` are accepted; anything else disables the
heartbeat with a warning that does not echo the URL.

**L4. npm: `undici` (8 advisories) and `vite` 8.3.0-8.3.2 (6 advisories), rated High by npm.**
Both are development-only (`npm audit --omit=dev` was already clean) and the dev server is
never exposed. *Fixed:* `npm audit fix` on the lockfile; both audits now report 0.

**L5. Inter is loaded from Google Fonts.** Every dashboard load tells Google the visitor's IP
address. *Accepted:* it is the only third-party request, the CSP allows exactly those two
hosts, and self-hosting the font is a visual-system change for a later task.

**L6. Login lockout is global behind the bundled nginx.** The limiter keys on the client
address, and behind nginx and Tailscale Serve every client arrives from the same address.
*Accepted:* with one administrator this is a lockout of the whole login form, which is the right
trade (it stops an attacker on the tailnet); an existing session is unaffected. The state is
in memory, so a restart clears it.

### Informational

* **I1.** `GET /health` is public and returns version, mode and whether Telegram and the bot are
  configured (never a value). The Docker healthcheck and the status pill need it. *Accepted.*
* **I2.** `/openapi.json` is reachable through nginx without a session. The schema is the
  published `contracts/openapi.json` in this open source repository. *Accepted.*
* **I3.** nginx does not send `Strict-Transport-Security`. TLS is terminated by Tailscale Serve
  or the operator's proxy, which should add it; over plain `http://127.0.0.1` browsers ignore
  it anyway. *Accepted.*
* **I4.** The CSP needs `style-src 'unsafe-inline'` because React renders `style=` attributes.
  Styles cannot run code, and `script-src` has no `unsafe-inline`. *Accepted.*
* **I5.** Debian packages in the API image: 45 HIGH findings with no fix published (`affected`
  or `fix_deferred`: util-linux, ncurses, sqlite and similar libraries that the application does
  not use through untrusted input). *Accepted;* the build runs `apt-get upgrade`, so a fix is
  picked up on the next rebuild.
* **I6.** The static GitHub Pages demo cannot set headers. It serves fictional data and has no
  backend. *Accepted.*

### False positives and triage

* **gitleaks: 874 hits, all `generic-api-key` on fake data, none real.** 852 are `product_key`
  slugs in the demo fixtures (`apps/web/src/demo-static/fixtures.json`), and 22 are test
  sentinels (`0123456789abcdef...` as an API hash, product slugs, `matched_at=NOW`). The history
  holds no `.session`, `.env` or `secrets.json` file (only `.env.example`). A `.gitleaks.toml`
  allowlist records the fixtures path and the exact test strings; gitleaks then reports no leaks.
* **bandit:** 0 findings at medium or above in the source. Low findings are `assert` in
  tests (B101), `random` in the demo data generator (B311, not security related), and "hardcoded
  password" matches on names such as `bot_token`, `password_invalid` and the public demo
  password `demo-teleyes` (B105, not secrets).
* **semgrep:** one finding, `insecure-file-permissions` on `os.chmod(directory, DIR_MODE)` in
  `packages/setup/secret_store.py`; `DIR_MODE` is `0o700`. Annotated with `nosemgrep`.

## What was reviewed by hand, and the result

| Area | Result |
|---|---|
| Password storage | Argon2id (`argon2-cffi` defaults); plaintext never stored. |
| Sessions | 256-bit random token; only its SHA-256 is stored in `admin_session`; sliding 24 h or absolute 30 days ("remember"); a new login drops the previous session (no fixation); a password reset signs everyone out. |
| Cookie | `HttpOnly`, `Secure` (unless the operator opts out for plain-http self-hosting), `SameSite=Strict`, no `Max-Age` unless "remember". |
| CSRF | Token is an HMAC of the cookie token, compared in constant time. **New test** walks every operation of the OpenAPI document (68, 65 of them non-public, 43 state-changing) and fails if a route answers anything but 401 without a session, or anything but 403 for a POST/PUT/PATCH/DELETE without a valid CSRF token. A new public route must be added to an allowlist in review. |
| Demo mode | **New test** sends every state-changing route to a read-only demo and expects 403 (the three documented exemptions are login, logout and the dry-run rule test). |
| Secrets in responses | **New test** plants a bot token and API hash through both the environment and the setup secret store, calls every parameter-free `GET`, and asserts none appears in a body or header. The setup wizard's own tests already cover its responses, events and 422 bodies. |
| Input size | Fixed (L2). Names, terms and prices are validated by the services; no endpoint accepts a file upload. |
| Path traversal | No HTTP endpoint takes a filesystem path. Backup and restore are scripts driven by environment variables; the CSV export is built in the browser. |
| SQL injection | SQLAlchemy throughout; the only string-built SQL is in a test. |
| ReDoS | No user-supplied regular expression exists (rule terms are literal); the price regexes are static. |
| SSRF | Outbound HTTP goes to `api.telegram.org` only (bot client, setup wizard), with the token validated or percent-encoded, and to the operator's own `HEARTBEAT_URL`. Telethon talks to Telegram's servers. |
| XSS | React escapes output; no `dangerouslySetInnerHTML`. Message links are built by the server from chat and message ids, and even a `javascript:` link could not run because the CSP has no inline script allowance. |

## Verification

* `pytest`: 1,318 tests pass, plus the 216 of `core/`; `ruff`, `mypy` clean; `tsc`, `oxlint` and Vitest (779 tests) pass.
* Playwright (Chromium, against the Vite dev server and a real API): the login, feed, rules,
  savings, health and history specs pass, apart from two groups. Three `session-recovery` specs
  fail because they still look for `.crud-table__name`, a class the sources redesign removed (the
  code under test is untouched by this audit). Five other specs failed once in a ten-minute
  combined run and passed when run on their own (the new login lock is not the cause: the run
  makes only two wrong-password attempts).
* The built images were started as an isolated Compose project and driven with Chromium: no CSP
  violation on any page, correct process owner, volume permissions and response headers.
* Trivy after the fixes: the web image has 0 CRITICAL/HIGH findings (before: 3 CRITICAL, 60 HIGH
  on an end-of-life Alpine); the API image has 0 CRITICAL and 45 HIGH without an available fix
  (before: 3 CRITICAL, 59 HIGH).

## Residual risks

* An attacker who can reach the login page can still try passwords at 5 per 5 minutes (then
  slower). Use a long password and keep the dashboard on a private network, as the README says.
* Whoever holds the administrator's session can use the setup wizard, which controls the
  Telegram account; this is documented in `SECURITY_SETUP.md` and mitigated by CSRF, rate limits
  and the explicit disconnect flow.
* The Telegram `.session` and `secrets.json` are protected by file permissions and the volume
  boundary, not by encryption (see `SECURITY_SETUP.md` for why).
* Dependencies in the Docker image are not hash-pinned; `constraints-ci.txt` pins CI only.

## How to repeat the audit

From a clean checkout, in a virtual environment dedicated to the tools:

```bash
python3 -m venv /tmp/audit-tools && /tmp/audit-tools/bin/pip install pip-audit bandit semgrep

# Dependencies
/tmp/audit-tools/bin/pip-audit -r constraints-ci.txt --no-deps --disable-pip
(cd apps/web && npm audit --omit=dev && npm audit)

# Secrets, whole history (brew install gitleaks; .gitleaks.toml is picked up automatically)
gitleaks detect --source . --redact --no-banner

# Code
/tmp/audit-tools/bin/bandit -r apps/api packages scripts core/src -ll \
  -x apps/api/tests,core/tests,packages/metrics/tests,packages/monitoring/tests,packages/telegram/tests
/tmp/audit-tools/bin/semgrep --config p/python --config p/typescript --config p/react \
  --metrics=off --exclude node_modules --exclude fixtures.json apps packages scripts core docker

# Images (build in an isolated project; do not print `docker compose config`, it expands secrets)
docker compose -p teleyes-audit -f docker-compose.yml build
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock aquasec/trivy:latest \
  image --severity CRITICAL,HIGH --scanners vuln teleyes-audit-api:latest
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock aquasec/trivy:latest \
  image --severity CRITICAL,HIGH --scanners vuln teleyes-audit-web:latest
docker compose -p teleyes-audit -f docker-compose.yml down -v --rmi local

# Behaviour: the security tests are part of the normal suites
pytest apps/api/tests/test_security_routes.py apps/api/tests/test_security_secrets.py \
  apps/api/tests/test_security_hardening.py apps/api/tests/test_docker_hardening.py
(cd apps/web && npx vitest run src/securityHeaders.test.ts src/utils/csv.test.ts)
```

To check the CSP against the real image, start the stack, create the administrator
(`docker compose exec -u teleyes -e TELEYES_ADMIN_PASSWORD=... api python scripts/create_admin.py`),
open each page with the browser console open (or a Playwright script listening to
`securitypolicyviolation`), and expect no violation.

Suggested follow-up for CI (not part of this task, since it needs the `workflow` token scope):
a scheduled job running the dependency, gitleaks and Trivy steps above.
