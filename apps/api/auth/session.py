import secrets
import time
from collections.abc import Callable
from dataclasses import dataclass


@dataclass
class SessionRecord:
    session_id: str
    admin_id: int
    csrf_token: str
    created_at: float
    expires_at: float


class SessionStore:
    """Server-side session store, in memory.

    Acceptable for v1: there is a single admin and the API runs as one
    process on the home machine (see CLAUDE.md) — no need for a shared/
    persistent session backend yet. Sessions are lost on restart, which just
    means the admin logs in again; nothing else depends on session survival.

    S13-08: `ttl_seconds` is a sliding *inactivity* window, not a fixed
    lifetime from creation — `get_session` pushes `expires_at` forward by
    `ttl_seconds` on every valid read, so a session only dies after that much
    time with no request at all, not 1h after login regardless of use (the
    bug that prompted this: the admin left the panel open, kept working past
    the old fixed 1h, and every write started failing with a confusing
    "invalid csrf token" instead of an expired-session message).

    24h of inactivity is the default: this is a single-admin, home-network
    panel behind Tailscale (never exposed publicly, see CLAUDE.md), so a
    generous window trades a little bit of session lifetime for a lot less
    of "why is my rule form suddenly broken" — the process still restarting
    wipes every session immediately regardless of this value (accepted
    trade-off, unchanged by this task).
    """

    def __init__(
        self,
        ttl_seconds: float = 86400.0,
        *,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._ttl_seconds = ttl_seconds
        self._clock = clock
        self._sessions: dict[str, SessionRecord] = {}

    def create_session(self, admin_id: int) -> SessionRecord:
        now = self._clock()
        record = SessionRecord(
            session_id=secrets.token_urlsafe(32),
            admin_id=admin_id,
            csrf_token=secrets.token_urlsafe(32),
            created_at=now,
            expires_at=now + self._ttl_seconds,
        )
        self._sessions[record.session_id] = record
        return record

    def get_session(self, session_id: str) -> SessionRecord | None:
        record = self._sessions.get(session_id)
        if record is None:
            return None
        now = self._clock()
        if now >= record.expires_at:
            del self._sessions[session_id]
            return None
        # Renew by activity: this read alone buys another full `ttl_seconds`
        # of inactivity before the session is considered gone.
        record.expires_at = now + self._ttl_seconds
        return record

    def delete_session(self, session_id: str) -> None:
        self._sessions.pop(session_id, None)
