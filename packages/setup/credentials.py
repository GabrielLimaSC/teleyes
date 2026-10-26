"""S19-02: resolve the Telegram credentials the app runs with.

Environment variables (`.env`) win; the wizard's `SecretStore` is the fallback. The
API id and hash travel as a pair: a half from the environment and a half from the
store would be two different Telegram apps. The bot token is independent.

Nothing here logs or returns a value to HTTP. `fingerprint` is a one-way digest the
listener uses only to notice that something changed.
"""

from __future__ import annotations

import hashlib
import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from packages.setup.secret_store import (
    KEY_API_HASH,
    KEY_API_ID,
    KEY_BOT_TOKEN,
    KEY_BOT_USERNAME,
    KEY_SESSION_GENERATION,
    SecretStore,
)

Source = Literal["env", "wizard"]

DEFAULT_SESSION_PATH = "data/teleyes.session"


@dataclass(frozen=True)
class TelegramCredentials:
    api_id: int | None
    api_hash: str | None
    api_source: Source | None
    bot_token: str | None
    bot_source: Source | None
    bot_username: str | None
    session_generation: int

    @property
    def has_api(self) -> bool:
        return self.api_id is not None and bool(self.api_hash)

    @property
    def has_bot(self) -> bool:
        return bool(self.bot_token)

    def __repr__(self) -> str:  # never let a secret reach a log line by accident
        return (
            f"TelegramCredentials(has_api={self.has_api}, api_source={self.api_source}, "
            f"has_bot={self.has_bot}, bot_source={self.bot_source})"
        )

    __str__ = __repr__


def _clean(value: object) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _int_or_none(value: object) -> int | None:
    text = _clean(value)
    if text is None:
        return None
    try:
        return int(text)
    except ValueError:
        return None


def resolve_credentials(
    store: SecretStore,
    *,
    env_api_id: object = None,
    env_api_hash: object = None,
    env_bot_token: object = None,
) -> TelegramCredentials:
    stored = store.read()
    api_id = _int_or_none(env_api_id)
    api_hash = _clean(env_api_hash)
    api_source: Source | None = "env"
    if api_id is None or api_hash is None:
        api_id = _int_or_none(stored.get(KEY_API_ID))
        api_hash = _clean(stored.get(KEY_API_HASH))
        api_source = "wizard"
    if api_id is None or api_hash is None:
        api_id, api_hash, api_source = None, None, None

    bot_token = _clean(env_bot_token)
    bot_source: Source | None = "env"
    if bot_token is None:
        bot_token = _clean(stored.get(KEY_BOT_TOKEN))
        bot_source = "wizard" if bot_token else None

    return TelegramCredentials(
        api_id=api_id,
        api_hash=api_hash,
        api_source=api_source,
        bot_token=bot_token,
        bot_source=bot_source,
        bot_username=_clean(stored.get(KEY_BOT_USERNAME)) if bot_source == "wizard" else None,
        session_generation=int(stored.get(KEY_SESSION_GENERATION, 0) or 0),
    )


def resolve_from_environ(store: SecretStore, environ: Mapping[str, str]) -> TelegramCredentials:
    return resolve_credentials(
        store,
        env_api_id=environ.get("TG_API_ID"),
        env_api_hash=environ.get("TG_API_HASH"),
        env_bot_token=environ.get("BOT_TOKEN"),
    )


def session_path_from_environ(environ: Mapping[str, str] | None = None) -> Path:
    values = os.environ if environ is None else environ
    return Path(values.get("TELEYES_SESSION_PATH") or DEFAULT_SESSION_PATH)


def secrets_path_for(session_path: Path, environ: Mapping[str, str] | None = None) -> Path:
    """`TELEYES_SECRETS_PATH`, else `secrets.json` beside the session file."""
    values = os.environ if environ is None else environ
    explicit = values.get("TELEYES_SECRETS_PATH")
    return Path(explicit) if explicit else session_path.parent / "secrets.json"


def session_present(session_path: Path) -> bool:
    try:
        return session_path.stat().st_size > 0
    except OSError:
        return False


def session_inode(session_path: Path) -> int:
    try:
        return session_path.stat().st_ino
    except OSError:
        return 0


def fingerprint(credentials: TelegramCredentials, session_path: Path) -> str:
    """Digest of everything whose change means "restart the Telegram connection"."""
    material = "|".join(
        [
            str(credentials.api_id),
            credentials.api_hash or "",
            credentials.bot_token or "",
            str(credentials.session_generation),
            str(session_inode(session_path)),
            str(session_present(session_path)),
        ]
    )
    return hashlib.sha256(material.encode()).hexdigest()


def not_ready_reason(credentials: TelegramCredentials, session_path: Path) -> str | None:
    """Why the listener must idle instead of connecting; `None` when it may start.

    The messages are for the operator's log and contain no values.
    """
    if not credentials.has_api:
        return (
            "TG_API_ID/TG_API_HASH ausentes — not_configured, sem fingir conexão. "
            "Use o assistente de configuração no painel (ou preencha o .env)."
        )
    if not credentials.has_bot:
        return (
            "BOT_TOKEN ausente — not_configured, sem fingir conexão. "
            "Use o assistente de configuração no painel (ou preencha o .env)."
        )
    if not session_present(session_path):
        return (
            "Sessão do Telegram ausente — not_configured, sem fingir conexão. "
            "Entre na conta pelo assistente de configuração no painel."
        )
    return None


def session_files(session_path: Path) -> list[Path]:
    """The session file and the SQLite side files Telethon may leave beside it."""
    return [session_path] + [
        session_path.with_name(session_path.name + suffix)
        for suffix in ("-journal", "-wal", "-shm")
    ]


def remove_session_files(session_path: Path) -> bool:
    """Delete the session; returns whether the main file existed."""
    existed = session_path.exists()
    for path in session_files(session_path):
        try:
            path.unlink()
        except FileNotFoundError:
            continue
    return existed
