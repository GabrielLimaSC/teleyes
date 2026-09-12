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
    """

    def __init__(
        self,
        ttl_seconds: float = 3600.0,
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
        if self._clock() >= record.expires_at:
            del self._sessions[session_id]
            return None
        return record

    def delete_session(self, session_id: str) -> None:
        self._sessions.pop(session_id, None)
