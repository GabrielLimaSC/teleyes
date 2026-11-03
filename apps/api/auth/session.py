import base64
import hashlib
import hmac
import secrets
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import delete
from sqlalchemy.orm import Session, sessionmaker

from models import AdminSession

REMEMBER_TTL_SECONDS = 30 * 86400.0
# `last_seen_at` (and the sliding expiry) is written at most this often per session, so
# a busy page does not turn every request into a database write.
TOUCH_INTERVAL_SECONDS = 60.0

_CSRF_LABEL = b"teleyes-csrf-v1"


@dataclass
class SessionRecord:
    # The cookie token as presented by the browser. Never persisted in clear.
    session_id: str
    admin_id: int
    csrf_token: str
    created_at: float
    expires_at: float
    remember: bool = False


def hash_token(token: str) -> str:
    """What the database stores in place of the cookie token."""
    return hashlib.sha256(token.encode()).hexdigest()


def derive_csrf_token(token: str) -> str:
    """The CSRF token is a keyed hash of the cookie token: stable for the whole session
    (so `/auth/me` can hand it back after a reload) and not recoverable from the stored
    hash, so a leaked database cannot forge it."""
    digest = hmac.new(token.encode(), _CSRF_LABEL, hashlib.sha256).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode()


def _to_datetime(epoch: float) -> datetime:
    return datetime.fromtimestamp(epoch, UTC)


def _to_epoch(value: datetime) -> float:
    # SQLite hands timezone-aware columns back naive; everything stored is UTC.
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value.timestamp()


class SessionStore:
    """Server-side session store, persisted in SQLite (S21-12).

    Sessions used to live in memory and vanished on every restart. They now live in
    `admin_session`, keyed by the SHA-256 of the cookie token: the clear token exists
    only in the browser's cookie.

    Two lifetimes, chosen at login:

    - default: a sliding *inactivity* window of `ttl_seconds` (S13-08, 24h). The cookie
      is a browser-session cookie. The expiry is pushed forward on use, but persisted
      at most once per `TOUCH_INTERVAL_SECONDS`, so the effective window can be up to a
      minute shorter than `ttl_seconds`.
    - `remember`: absolute `REMEMBER_TTL_SECONDS` (30 days) from login, never extended,
      matching the cookie's Max-Age. Staying logged in longer means logging in again.

    Expired rows are removed when found and swept on every login.
    """

    def __init__(
        self,
        session_factory: sessionmaker[Session],
        ttl_seconds: float = 86400.0,
        *,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._session_factory = session_factory
        self._ttl_seconds = ttl_seconds
        self._clock = clock

    def create_session(self, admin_id: int, *, remember: bool = False) -> SessionRecord:
        now = self._clock()
        token = secrets.token_urlsafe(32)
        ttl = REMEMBER_TTL_SECONDS if remember else self._ttl_seconds
        record = SessionRecord(
            session_id=token,
            admin_id=admin_id,
            csrf_token=derive_csrf_token(token),
            created_at=now,
            expires_at=now + ttl,
            remember=remember,
        )
        with self._session_factory() as db:
            db.execute(delete(AdminSession).where(AdminSession.expires_at <= _to_datetime(now)))
            db.add(
                AdminSession(
                    id_hash=hash_token(token),
                    admin_id=admin_id,
                    created_at=_to_datetime(now),
                    last_seen_at=_to_datetime(now),
                    expires_at=_to_datetime(record.expires_at),
                    remember=remember,
                )
            )
            db.commit()
        return record

    def get_session(self, session_id: str) -> SessionRecord | None:
        id_hash = hash_token(session_id)
        now = self._clock()
        with self._session_factory() as db:
            row = db.get(AdminSession, id_hash)
            if row is None:
                return None
            expires_at = _to_epoch(row.expires_at)
            if now >= expires_at:
                db.delete(row)
                db.commit()
                return None
            if now - _to_epoch(row.last_seen_at) >= TOUCH_INTERVAL_SECONDS:
                row.last_seen_at = _to_datetime(now)
                if not row.remember:
                    # Renew by activity: a valid read buys another `ttl_seconds`.
                    expires_at = now + self._ttl_seconds
                    row.expires_at = _to_datetime(expires_at)
                db.commit()
            return SessionRecord(
                session_id=session_id,
                admin_id=row.admin_id,
                csrf_token=derive_csrf_token(session_id),
                created_at=_to_epoch(row.created_at),
                expires_at=expires_at,
                remember=row.remember,
            )

    def delete_session(self, session_id: str) -> None:
        with self._session_factory() as db:
            db.execute(delete(AdminSession).where(AdminSession.id_hash == hash_token(session_id)))
            db.commit()

    def delete_all_sessions(self) -> None:
        """Sign every browser out (password reset)."""
        with self._session_factory() as db:
            db.execute(delete(AdminSession))
            db.commit()
