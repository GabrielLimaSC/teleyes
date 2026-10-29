"""S19-02: security audit events of the setup wizard.

Only a closed set of event kinds and reason codes can be recorded, so no phone number,
code, name, chat id or token can ever reach the table or the log by this route. The
log line is a flat `event=... detail=...` pair for the same reason.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Literal

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from models import SecurityEvent

logger = logging.getLogger(__name__)

EventKind = Literal[
    "telegram_credentials_saved",
    "telegram_login_started",
    "telegram_login_succeeded",
    "telegram_login_failed",
    "telegram_login_cancelled",
    "bot_configured",
    "bot_paired",
    "session_removed",
    "rate_limited",
]
EVENT_KINDS: frozenset[str] = frozenset(EventKind.__args__)  # type: ignore[attr-defined]

KEEP_LAST = 500


def record_event(session: Session, kind: EventKind, detail: str | None = None) -> None:
    """Persist and log one event. `detail` must be a short code, never user input."""
    if kind not in EVENT_KINDS:
        raise ValueError("unknown security event kind")
    safe_detail = detail if detail is None or detail.replace("_", "").isalnum() else "other"
    session.add(SecurityEvent(kind=kind, detail=safe_detail, created_at=datetime.now(UTC)))
    session.flush()
    stale = session.scalars(
        select(SecurityEvent.id).order_by(SecurityEvent.id.desc()).offset(KEEP_LAST).limit(1)
    ).first()
    if stale is not None:
        session.execute(delete(SecurityEvent).where(SecurityEvent.id <= stale))
    session.commit()
    logger.info("event=%s detail=%s", kind, safe_detail or "-")


def recent_events(session: Session, limit: int = 10) -> list[SecurityEvent]:
    return list(
        session.scalars(select(SecurityEvent).order_by(SecurityEvent.id.desc()).limit(limit))
    )
