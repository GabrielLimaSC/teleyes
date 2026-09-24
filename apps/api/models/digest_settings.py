from datetime import UTC, datetime

from sqlalchemy import Boolean, DateTime, String
from sqlalchemy.orm import Mapped, mapped_column

from models.base import Base

# The only row that ever exists (mirrors `models.listener_control`'s own
# single-row mailbox pattern): the panel writes it through `PUT /digest`, and
# the listener's digest scheduler reads it every tick.
DIGEST_SETTINGS_ID = 1


class DigestSettings(Base):
    """S14-04 (F4): the daily digest's one-row configuration.

    Absent (no row at all) means "never configured" — treated everywhere as
    fully off (`app.digest_settings.load_digest_settings` returns an
    unpersisted default with `enabled=False`), so a fresh install changes
    nothing about today's immediate-delivery behavior until Gabriel opens the
    panel and saves a configuration.
    """

    __tablename__ = "digest_settings"

    id: Mapped[int] = mapped_column(primary_key=True, default=DIGEST_SETTINGS_ID)
    enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    # "HH:MM" in `Settings.display_timezone` (app/config.py) — validated by the
    # router, parsed by `app.digest_settings.parse_send_at_local`.
    send_at_local: Mapped[str] = mapped_column(String(5), default="09:00")
    top_n: Mapped[int] = mapped_column(default=5)
    # S14-04 (F4): when off, a common match keeps sending immediately (today's
    # behavior, unchanged) even with the digest enabled/configured — the
    # digest only ever intercepts individual delivery once this is also on.
    mute_individual: Mapped[bool] = mapped_column(Boolean, default=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(UTC),
        onupdate=lambda: datetime.now(UTC),
    )
