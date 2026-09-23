from datetime import UTC, datetime

from sqlalchemy import DateTime, ForeignKey, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from models.base import Base


class Match(Base):
    __tablename__ = "match"
    __table_args__ = (
        UniqueConstraint(
            "source_id",
            "rule_id",
            "telegram_message_id",
            name="uq_match_source_rule_telegram_message",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    source_id: Mapped[int] = mapped_column(ForeignKey("source.id"))
    rule_id: Mapped[int] = mapped_column(ForeignKey("rule.id"))
    telegram_message_id: Mapped[int | None] = mapped_column(nullable=True)
    message_text: Mapped[str] = mapped_column(String)
    price_cents: Mapped[int | None] = mapped_column(nullable=True)
    # S7-05: only ever set together, and only when the message has two
    # explicit, distinct textual anchors (packages/rules/price.py) — never a
    # guess. `price_cents` above keeps mirroring the cash value when both are
    # set, so every existing filter/sort/ordering by `price_cents` keeps
    # working unchanged.
    price_cash_cents: Mapped[int | None] = mapped_column(nullable=True)
    price_card_cents: Mapped[int | None] = mapped_column(nullable=True)
    message_link: Mapped[str | None] = mapped_column(String, nullable=True)
    # S14-01: `packages.rules.product.product_key(message_text)`, computed on
    # insert (and backfilled by migration 7e2a9c4d1b35). NULL when the message
    # has no recognisable product title. Never edited by hand.
    product_key: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    matched_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(UTC)
    )
