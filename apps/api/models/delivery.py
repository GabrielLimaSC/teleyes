from datetime import UTC, datetime

from sqlalchemy import DateTime, ForeignKey, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from models.base import Base


class Delivery(Base):
    __tablename__ = "delivery"
    __table_args__ = (
        UniqueConstraint("match_id", "recipient_id", name="uq_delivery_match_recipient"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    match_id: Mapped[int] = mapped_column(ForeignKey("match.id"))
    recipient_id: Mapped[int] = mapped_column(ForeignKey("recipient.id"))
    status: Mapped[str] = mapped_column(String(32), default="pending")
    delivered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(UTC)
    )
