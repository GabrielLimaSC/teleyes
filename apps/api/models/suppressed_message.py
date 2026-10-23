from datetime import UTC, datetime

from sqlalchemy import DateTime, ForeignKey, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from models.base import Base


class SuppressedMessage(Base):
    """S20-01: identity (source + Telegram message id) of a message whose match the
    admin deleted. Without it, a historical re-scan (S6-02) would find the
    message again, the `Match` unique constraint would no longer block it, and
    the wrong-price listing would come back. Only the identity is kept, never
    the message text (CLAUDE.md: no content retention beyond matches).
    """

    __tablename__ = "suppressed_message"
    __table_args__ = (
        UniqueConstraint("source_id", "telegram_message_id", name="uq_suppressed_source_message"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    source_id: Mapped[int] = mapped_column(ForeignKey("source.id"))
    telegram_message_id: Mapped[int] = mapped_column()
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(UTC)
    )
