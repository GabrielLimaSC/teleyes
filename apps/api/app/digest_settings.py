"""S14-04 (F4): the single `digest_settings` row — read/write only, no
scheduling or sending here.

Kept apart from `app.digest` (the scheduler + the actual send) on purpose:
`app.pipeline.process_message` needs to read this row on every common match
to decide immediate-vs-digest, and it must never import the scheduler module
(which itself imports `app.pipeline` for the delivery kind/status constants —
that would be a cycle). This module has no dependency on `app.pipeline` at
all, so it is safe for both sides to import.
"""

from __future__ import annotations

from datetime import time

from sqlalchemy.orm import Session

from models import DigestSettings
from models.digest_settings import DIGEST_SETTINGS_ID

DEFAULT_SEND_AT_LOCAL = "09:00"
DEFAULT_TOP_N = 5


def load_digest_settings(session: Session) -> DigestSettings:
    """The single settings row, or an unpersisted default (`enabled=False`)
    when Gabriel has never configured it yet — never creates a row as a side
    effect of a read, including from the hot pipeline path.
    """
    row = session.get(DigestSettings, DIGEST_SETTINGS_ID)
    if row is not None:
        return row
    return DigestSettings(
        id=DIGEST_SETTINGS_ID,
        enabled=False,
        send_at_local=DEFAULT_SEND_AT_LOCAL,
        top_n=DEFAULT_TOP_N,
        mute_individual=False,
    )


def save_digest_settings(
    session: Session,
    *,
    enabled: bool,
    send_at_local: str,
    top_n: int,
    mute_individual: bool,
) -> DigestSettings:
    """`PUT /digest`'s write: create the row on the first save, update it after."""
    row = session.get(DigestSettings, DIGEST_SETTINGS_ID)
    if row is None:
        row = DigestSettings(id=DIGEST_SETTINGS_ID)
        session.add(row)
    row.enabled = enabled
    row.send_at_local = send_at_local
    row.top_n = top_n
    row.mute_individual = mute_individual
    session.commit()
    session.refresh(row)
    return row


def parse_send_at_local(value: str) -> time:
    """`"HH:MM"` (24h) -> `time`. Raises `ValueError` on anything else — the
    router turns that into a 422; the scheduler treats it defensively as "not
    due" (see `app.digest.DigestScheduler.tick`) rather than crashing its loop.
    """
    parts = value.split(":")
    if len(parts) != 2 or not all(part.isdigit() for part in parts):
        raise ValueError(f"invalid HH:MM: {value!r}")
    hour_str, minute_str = parts
    if len(hour_str) not in (1, 2) or len(minute_str) != 2:
        raise ValueError(f"invalid HH:MM: {value!r}")
    return time(hour=int(hour_str), minute=int(minute_str))
