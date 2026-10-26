# Security model of the setup wizard (S19-02)

The first-run wizard lets the administrator connect Telegram from the dashboard instead of editing
`.env` and running scripts. It handles three things that are worth a lot to an attacker: the Telegram
**API hash**, a **bot token**, and a **login session** for the user's Telegram account (equivalent to
the full account: read every chat, send as the user). This document says what we protect, from whom,
and how each control is implemented and tested.

Code: `apps/api/app/routers/setup.py` (HTTP), `packages/setup/` (secret store, Telegram login, Bot
API client), `apps/api/app/dialog_scan.py` (group list), `scripts/run_listener.py` (consumer).
Tests: `apps/api/tests/test_setup_*.py`.

## Assets and trust boundaries

| Asset | Where it lives | Who may read it |
|---|---|---|
| Telegram session (`teleyes.session`) | `teleyes_session` volume, 0600, dir 0700 | `listener` (uses it), `api` (writes it once at login, deletes it on disconnect) |
| API id/hash, bot token (`secrets.json`) | same volume, 0600 | same two processes |
| Dashboard password | Argon2 hash in the database | `api` |
| Matches, rules, recipients | SQLite (`teleyes_data`), backed up | `api`, `listener`, `backup` |

Trust boundary: the machine running Docker and its administrator are trusted. The browser session
(cookie) is **not** treated as proof that the person at the keyboard is the owner: a stolen cookie must
not become a way to take over the Telegram account (see T2, T3).

The server listens on `127.0.0.1` only by default. **Exposing the dashboard to the public internet is
unsupported**, and with the wizard it is worse than before: anyone who reaches the login page and
guesses the password can attach their own Telegram account or bot, or detach yours. Use Tailscale
Serve or a VPN for remote access, keep `SESSION_COOKIE_SECURE=true` behind HTTPS, and choose a long
dashboard password.

## Where the secrets are stored, and why

Decision: **a single JSON file, `secrets.json`, in the session volume** (`TELEYES_SECRETS_PATH`
overrides the location). Mode 0600, directory 0700, atomic writes (temp file in the same directory,
`fsync`, `os.replace`) serialised by an exclusive `flock`, so two tabs or two processes cannot lose or
tear an update.

Alternatives considered:

* **Columns in SQLite.** Rejected. The database is backed up every six hours and backups get copied
  around; secrets in them would travel too. The session volume is deliberately outside the backups.
* **Encrypted columns with a master key.** Rejected. A key stored next to the ciphertext in the same
  volume (the only place a headless container can keep it) adds no real protection over file
  permissions, and adds a failure mode (lost key = lost config). The boundary that matters is the
  volume, the file mode and never exposing values over HTTP or logs.
* **Writing into `.env`.** Rejected. The `api` container does not mount it, `.env` is read-only
  configuration for humans, and rewriting a hand-edited file from a web request is fragile.

`Settings` precedence: **environment (`.env`) first, then `secrets.json`**. `TG_API_ID`/`TG_API_HASH`
are taken as a pair (never half from each source). A value that comes from the environment cannot be
changed or deleted from the wizard (409 `managed_by_env`); the author's own deployment keeps working
unchanged. The listener re-reads both sources every five seconds, so it needs no restart when the
wizard finishes; a change of credentials or session tears the connection down and rebuilds it.

## Threats and controls

**T1. Unauthenticated access to configuration.** Every `/setup/*` route requires an admin session
cookie (HttpOnly, SameSite=strict) and every route that changes anything also requires the CSRF token
(`require_csrf`). There is no public configuration route. Creating the admin stays in `install.sh`
(`scripts/create_admin.py`); the web cannot create or reset it. Tests: `test_every_setup_route_needs_a_session`,
`test_every_mutating_setup_route_needs_the_csrf_token` (also asserts a rejected call writes nothing).

**T2. Brute force through a stolen cookie (api as an oracle against the Telegram account).** Sign-in
codes and 2FA passwords are guessable only through us, so those routes are rate limited by
`EscalatingRateLimiter` (`auth/rate_limit.py`): 5 wrong answers in 10 minutes lock the action for 60 s,
and each further lock-out doubles (cap 1 h). The key is the action, not the client address, because
there is one administrator and behind a proxy every client shares one address. Starting a login (which
makes Telegram send a code to a phone) is limited to 3 per 15 minutes with a 5-minute backoff; bot-token
guesses to 5 per 10 minutes. A pending login also dies after 5 wrong answers, so the limiter and the
attempt counter cannot be bypassed by restarting. Telegram's own flood-wait is shown with its duration
and honoured. Tests: `test_the_login_start_is_rate_limited_with_a_backoff`,
`test_guessing_codes_is_rate_limited_across_fresh_login_attempts`, `..._2fa_passwords...`, `..._bot_tokens...`.

**T3. Hijacking by replacing the account or the bot.** Starting a login is refused while a session
exists (409) and credentials cannot be swapped under a session; replacing means the explicit,
confirmed **Desconectar Telegram** action, which is audited. Replacing the bot token is the explicit
"Trocar bot token" action; recipients stay registered but must pair again with the new bot.

**T4. A stranger becomes an alert recipient.** The bot's username is public, so "register whoever
sends /start" would let anyone join. Pairing instead opens a 10-minute window with a random one-time
code in a deep link (`https://t.me/<bot>?start=<code>`); only a private `/start <code>` that matches
(constant-time comparison) registers a recipient; `/start` without the code is ignored and counted so
the UI can explain. Tests: `test_a_stranger_who_starts_the_bot_without_the_code_is_never_registered`.

**T5. Secret disclosure over HTTP.** Responses carry only `configured`, `source` (`env`/`wizard`), the
bot's public `@username`, a masked phone hint (`+55•••••••4321`) and state names. Nothing returned ever
includes the API hash, token, code, password, session content or chat ids of strangers. FastAPI's
default 422 body echoes the rejected input, which under `/setup` could be an API hash or password, so a
handler strips `input` for these paths. Error bodies are `{code, message}` from a closed vocabulary.
Test: `test_no_response_ever_contains_a_secret`, `test_a_validation_error_never_echoes_the_rejected_value`.

**T6. Secret disclosure through logs, events and exceptions.** Audit events (`security_event` table and a
log line) take only a kind and a reason code from closed sets (`telegram_login_started`/`succeeded`/
`failed`/`cancelled`, `telegram_credentials_saved`, `bot_configured`, `bot_paired`, `session_removed`,
`rate_limited`); no phone, name, chat id or value is accepted by `record_event`. Library errors are
reduced to codes and re-raised with `from None`: Telethon errors can quote phone numbers and `httpx`
errors carry the request URL, which contains the bot token. The `httpx`/`httpcore` loggers are held at
WARNING with a token-redacting filter because `httpx` logs every request line at INFO. Credentials
objects have a `repr` that prints no value. Listener messages never include values. SSE events are
unchanged and carry no setup data. Tests: `test_logs_never_contain_a_secret` (caplog at DEBUG over a
full flow with sentinel values), `test_audit_events_are_a_closed_set_without_personal_data`,
`test_a_network_failure_never_leaks_the_token_through_the_exception`.

**T7. Leaking or double-using the Telegram login.** Only one login can be pending (409
`already_pending`), held in memory only, never persisted, with a 5-minute TTL enforced both lazily and by
a timer that disconnects the client even if nobody calls again. The Telethon client is disconnected on
success, failure, expiry, cancel and shutdown (`finally`/lifespan). The session is created at a
*pending* path and moved over the real one with `os.replace` only after a successful sign-in, so a
failed login never leaves a half-valid `.session` the listener could pick up. Deleting removes the file
and its SQLite side files. Tests: `test_setup_login_service.py` (TTL, timer, cleanup, concurrency),
`test_no_task_or_socket_is_left_behind_after_a_full_flow`.

**T8. Two processes using one Telegram auth key.** Using one session from two places at once can make
Telegram revoke it (`AUTH_KEY_DUPLICATED`). The `api` therefore never connects with the saved session.
The group list is fetched by the **listener** (the only process that uses the session) through a
database mailbox (`dialog_scan`), the same pattern as "Aplicar regras". It calls only `iter_dialogs`:
the app never joins, replies, reacts or forwards.

**T9. Untrusted input.** Phone numbers must be E.164; codes 4-8 digits; API hash 32 hex characters; API id
1..2^31-1; bot token must match `\d{5,16}:[A-Za-z0-9_-]{30,64}` before it is ever placed in a URL; all
bodies have length limits. The group selection accepts only chat ids the listener itself reported.
The only outbound hosts are Telegram's MTProto endpoints (Telethon) and `api.telegram.org`; no
user-supplied URL is ever fetched, so there is no SSRF surface.

**T10. Demo mode.** With `TELEYES_DEMO=1` every `/setup/*` route returns 403 `demo_mode`, and the static
demo hides the wizard. A public demo must never be able to attach an account.

**T11. File races and permissions.** Atomic writes + `flock` (above); directories created 0700, files
0600, entrypoints re-tighten them on boot. Tests: `test_concurrent_updates_never_lose_one_another`,
`test_store_creates_a_private_directory_and_a_0600_file`.

## Residual risks and what the wizard cannot do

* **Disconnecting deletes the local session; it does not end it at Telegram.** Only the account owner can
  do that (Telegram > Settings > Devices). The UI says so. If the volume or the dashboard was exposed,
  terminate the session there and regenerate the API hash at my.telegram.org.
* A compromised host, container or Docker volume exposes everything above. Prefer a dedicated Telegram
  account; the wizard warns about it before the phone step.
* The dashboard password is the front door. Rate limiting of the dashboard login is per client address
  (`LoginRateLimiter`), which is weak behind a shared reverse proxy.
* Plain `http://127.0.0.1` installs use a non-Secure cookie (`SESSION_COOKIE_SECURE=false`); that is fine
  on loopback, not on a network.
* The Telegram login and group listing could not be exercised against the real service by the authors'
  automated tests (a fake client is injected). `docs/SETUP_MANUAL_VALIDATION.md` lists the manual
  checks to run with a test account.

## Reporting

See `SECURITY.md`. If you suspect the secrets leaked: use **Desconectar Telegram**, end the session in
Telegram's Devices list, regenerate the API hash and revoke the bot token with @BotFather.
