"""S19-02: where the setup wizard keeps the secrets it collects.

One small JSON file (`secrets.json`) next to the Telegram session, in the session
volume. That volume holds everything equal to account access, is never part of the
database backups and is mounted by the `api` (writes) and the `listener` (reads).

Why a file and not an encrypted column: a master key kept beside the ciphertext, in
the same volume, adds no protection the file permissions do not already give. The
real boundaries are the 0600 mode, the 0700 directory, the volume separation from
the backups, and never returning the values over HTTP or logging them.

Writes are atomic (temp file in the same directory, fsync, `os.replace`) and
serialised across processes and tabs by an exclusive `flock` on a sidecar lock file,
so a reader never sees a half-written file and two concurrent updates never lose
one another. Nothing in this module logs values.
"""

from __future__ import annotations

import contextlib
import fcntl
import json
import os
import tempfile
from collections.abc import Iterator
from pathlib import Path
from typing import Any

FILE_MODE = 0o600
DIR_MODE = 0o700

# Keys the wizard stores. `bot_username` and `session_generation` are not secrets;
# they live here so the listener can notice a change without touching the database.
KEY_API_ID = "tg_api_id"
KEY_API_HASH = "tg_api_hash"
KEY_BOT_TOKEN = "bot_token"
KEY_BOT_USERNAME = "bot_username"
KEY_SESSION_GENERATION = "session_generation"
ALLOWED_KEYS = frozenset(
    {KEY_API_ID, KEY_API_HASH, KEY_BOT_TOKEN, KEY_BOT_USERNAME, KEY_SESSION_GENERATION}
)


class SecretStore:
    def __init__(self, path: Path) -> None:
        self.path = path
        self._lock_path = path.with_name(path.name + ".lock")

    def read(self) -> dict[str, Any]:
        """Current contents; `{}` when the file is absent, unreadable or malformed."""
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        if not isinstance(data, dict):
            return {}
        return {key: value for key, value in data.items() if key in ALLOWED_KEYS}

    def update(self, changes: dict[str, Any]) -> None:
        """Merge `changes` in; a `None` value removes the key."""
        if set(changes) - ALLOWED_KEYS:
            raise ValueError("unknown secret key")
        with self._exclusive():
            current = self.read()
            for key, value in changes.items():
                if value is None:
                    current.pop(key, None)
                else:
                    current[key] = value
            self._write(current)

    def clear_secrets(self) -> None:
        """Remove every credential, keeping only the non-secret change counter."""
        with self._exclusive():
            current = self.read()
            self._write({k: v for k, v in current.items() if k == KEY_SESSION_GENERATION})

    def bump_generation(self) -> int:
        """Increment the session generation the listener watches; returns the new value."""
        with self._exclusive():
            current = self.read()
            generation = int(current.get(KEY_SESSION_GENERATION, 0)) + 1
            current[KEY_SESSION_GENERATION] = generation
            self._write(current)
        return generation

    @contextlib.contextmanager
    def _exclusive(self) -> Iterator[None]:
        self._ensure_directory()
        descriptor = os.open(self._lock_path, os.O_RDWR | os.O_CREAT, FILE_MODE)
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX)
            yield
        finally:
            try:
                fcntl.flock(descriptor, fcntl.LOCK_UN)
            finally:
                os.close(descriptor)

    def _ensure_directory(self) -> None:
        directory = self.path.parent
        if not directory.exists():
            directory.mkdir(parents=True, exist_ok=True, mode=DIR_MODE)
            # mkdir's mode is masked by the umask; make it exact for a directory we made.
            os.chmod(directory, DIR_MODE)

    def _write(self, data: dict[str, Any]) -> None:
        descriptor, temp_name = tempfile.mkstemp(
            prefix=".secrets-", suffix=".tmp", dir=self.path.parent
        )
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                os.fchmod(handle.fileno(), FILE_MODE)
                json.dump(data, handle, separators=(",", ":"))
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temp_name, self.path)
        except BaseException:
            with contextlib.suppress(OSError):
                os.unlink(temp_name)
            raise
