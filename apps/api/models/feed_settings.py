from datetime import UTC, datetime

from sqlalchemy import Boolean, DateTime
from sqlalchemy.orm import Mapped, mapped_column

from models.base import Base

# The only row that ever exists (S14-05), same single-row pattern as
# `models.listener_control.LISTENER_CONTROL_ID`.
FEED_SETTINGS_ID = 1


class FeedSettings(Base):
    """S14-05 (F5): the feed's own display preferences — for now, only the
    "Agrupar duplicatas" toggle. Lazily created on first read or write
    (`app.feed_settings`), never seeded by its migration, same reasoning as
    `ListenerControl`.
    """

    __tablename__ = "feed_settings"

    id: Mapped[int] = mapped_column(primary_key=True, default=FEED_SETTINGS_ID)
    group_duplicates: Mapped[bool] = mapped_column(Boolean, default=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(UTC),
        onupdate=lambda: datetime.now(UTC),
    )
