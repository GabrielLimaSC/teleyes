from datetime import UTC, datetime

from sqlalchemy import DateTime, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from models.base import Base


class Match(Base):
    __tablename__ = "match"

    id: Mapped[int] = mapped_column(primary_key=True)
    source_id: Mapped[int] = mapped_column(ForeignKey("source.id"))
    rule_id: Mapped[int] = mapped_column(ForeignKey("rule.id"))
    message_text: Mapped[str] = mapped_column(String)
    price_cents: Mapped[int | None] = mapped_column(nullable=True)
    message_link: Mapped[str | None] = mapped_column(String, nullable=True)
    matched_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(UTC)
    )
