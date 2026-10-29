# Security Policy

## Reporting a vulnerability

Please report vulnerabilities privately. Do not open a public issue.

Use GitHub's private vulnerability reporting: go to the repository's **Security** tab and choose
**Report a vulnerability** (or open a draft security advisory). Include what you found, how to reproduce it
and what you think the impact is. Reports are handled on a best-effort basis by the maintainer.

## What must never be shared

teleyes reads Telegram through an MTProto user session. The session file (`*.session`) is equivalent to a
full login to that Telegram account: anyone holding it can read messages, send as the account and
access everything the account can access.

Never share, attach or paste in an issue, pull request, log or screenshot:

- the Telegram `.session` file and `secrets.json` (where the setup wizard keeps the API credentials
  and the bot token);
- `TG_API_ID` / `TG_API_HASH` and the bot token (`BOT_TOKEN`);
- your `.env`, the SQLite database or its backups;
- dashboard cookies or the admin password.

If any of these leaked, revoke them right away: terminate the session in Telegram (Settings, Devices),
regenerate the API credentials, and revoke the bot token with @BotFather.

## The setup wizard

The dashboard can connect Telegram for you (API credentials, account login, bot, groups). That gives the
dashboard administrator full power over the connected Telegram account, so it is limited to the
authenticated administrator, protected by CSRF and rate limits, disabled in demo mode, and never returns or
logs a secret. The threat model, the storage decision and the residual risks are in
[`docs/SECURITY_SETUP.md`](docs/SECURITY_SETUP.md).

## Scope

teleyes is designed as a single-administrator, self-hosted tool reachable only on a private network
(for example Tailscale Serve). Exposing it directly to the public internet is unsupported.
