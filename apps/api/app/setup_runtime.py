"""S19-02: process-wide plumbing of the setup wizard (paths, credentials, limits)."""

from __future__ import annotations

import asyncio
import secrets
import time
from dataclasses import dataclass, field
from pathlib import Path

from app.config import Settings
from auth.rate_limit import EscalatingRateLimiter
from packages.setup.credentials import (
    TelegramCredentials,
    resolve_credentials,
    secrets_path_for,
)
from packages.setup.secret_store import SecretStore

PAIRING_TTL_SECONDS = 600.0
PAIRING_POLL_SECONDS = 8

# Limiter keys. Each guards one thing an attacker with a stolen cookie could abuse.
LIMIT_LOGIN_START = "login_start"  # every start makes Telegram send a code to a phone
LIMIT_LOGIN_ANSWER = "login_answer"  # code and 2FA guesses against the account
LIMIT_BOT_TOKEN = "bot_token"  # token guesses (each one is a request to Telegram)


def session_path(settings: Settings) -> Path:
    return Path(settings.teleyes_session_path)


def build_secret_store(settings: Settings) -> SecretStore:
    explicit = settings.teleyes_secrets_path
    environ = {"TELEYES_SECRETS_PATH": explicit} if explicit else {}
    return SecretStore(secrets_path_for(session_path(settings), environ))


def current_credentials(store: SecretStore, settings: Settings) -> TelegramCredentials:
    return resolve_credentials(
        store,
        env_api_id=settings.tg_api_id,
        env_api_hash=settings.tg_api_hash,
        env_bot_token=settings.bot_token,
    )


def build_limiters() -> dict[str, EscalatingRateLimiter]:
    return {
        LIMIT_LOGIN_START: EscalatingRateLimiter(
            max_failures=3, window_seconds=900.0, base_lockout_seconds=300.0
        ),
        LIMIT_LOGIN_ANSWER: EscalatingRateLimiter(
            max_failures=5, window_seconds=600.0, base_lockout_seconds=60.0
        ),
        LIMIT_BOT_TOKEN: EscalatingRateLimiter(
            max_failures=5, window_seconds=600.0, base_lockout_seconds=60.0
        ),
    }


@dataclass
class Pairing:
    """A short-lived window in which `/start <code>` registers a recipient.

    Without the code, anyone who finds the bot's username and sends `/start` while
    the wizard is polling would become an allowlisted recipient of the alerts.
    """

    code: str
    expires_at: float
    offset: int | None = None
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    @classmethod
    def new(cls, now: float | None = None) -> Pairing:
        moment = time.monotonic() if now is None else now
        return cls(code=secrets.token_urlsafe(6), expires_at=moment + PAIRING_TTL_SECONDS)

    def remaining(self, now: float | None = None) -> int:
        moment = time.monotonic() if now is None else now
        return max(0, int(self.expires_at - moment))
