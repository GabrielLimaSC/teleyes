"""S14-05 (F5): the feed's own single-row config — for now, just the
"Agrupar duplicatas" toggle. Same single-row pattern as `app.listener_control`
(`FeedSettings`, id always `FEED_SETTINGS_ID`), lazily created on first read
or write rather than seeded by a migration.
"""

from __future__ import annotations

from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session

from models import FeedSettings
from models.feed_settings import FEED_SETTINGS_ID


def _ensure_row(session: Session) -> None:
    """Create the single row if missing. Safe if two requests race here."""
    session.execute(
        sqlite_insert(FeedSettings)
        .values(id=FEED_SETTINGS_ID, group_duplicates=True)
        .on_conflict_do_nothing(index_elements=["id"])
    )


def get_group_duplicates(session: Session) -> bool:
    """The current toggle, defaulting to `True` (the model/migration default)
    when the row does not exist yet. Never writes on a plain read.
    """
    row = session.get(FeedSettings, FEED_SETTINGS_ID)
    return row.group_duplicates if row is not None else True


def set_group_duplicates(session: Session, value: bool) -> FeedSettings:
    _ensure_row(session)
    session.flush()
    row = session.get(FeedSettings, FEED_SETTINGS_ID)
    assert row is not None
    row.group_duplicates = value
    session.commit()
    session.refresh(row)
    return row
