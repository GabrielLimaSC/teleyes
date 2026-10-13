from datetime import UTC, datetime

from sqlalchemy import DateTime, ForeignKey, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from models.base import Base


class Delivery(Base):
    """S14-02: `kind` distinguishes the normal alert channel (`"immediate"`)
    from the prioritized price-target channel (`"target"`). Almost every
    match still gets exactly one `Delivery` row per recipient, same as
    before `kind` existed — but a match that both (a) is a repeat of an
    already-notified promotion (`app.pipeline._already_notified_group_match_exists`)
    and (b) hits its rule's target needs *two*: the suppressed `"immediate"`
    bookkeeping row (unchanged behavior) plus the `"target"` row that fires
    anyway, since a target hit ignores that suppression (Gabriel,
    2026-09-23). The unique constraint grew a third column, `kind`, so the
    database allows exactly that one case and still blocks every real
    duplicate (same match, same recipient, same channel).
    """

    __tablename__ = "delivery"
    __table_args__ = (
        UniqueConstraint(
            "match_id", "recipient_id", "kind", name="uq_delivery_match_recipient_kind"
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    match_id: Mapped[int] = mapped_column(ForeignKey("match.id"))
    recipient_id: Mapped[int] = mapped_column(ForeignKey("recipient.id"))
    status: Mapped[str] = mapped_column(String(32), default="pending")
    kind: Mapped[str] = mapped_column(String(16), default="immediate")
    delivered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(UTC)
    )
