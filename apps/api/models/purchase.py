from datetime import UTC, datetime

from sqlalchemy import CheckConstraint, DateTime, String
from sqlalchemy.orm import Mapped, mapped_column

from models.base import Base


class Purchase(Base):
    """S19-04: something the admin actually bought, registered by hand.

    The app cannot know what was bought, so this is the one table filled by the admin
    instead of the pipeline. It deliberately holds no Telegram content: no message
    text, no link, no group name. `name` and `store` are free text typed by the admin.
    `product_key` / `rule_id` optionally link the purchase to what the app watched, so
    the savings report can compare the price paid with the prices seen; neither is a
    foreign key, so deleting a rule never blocks or erases a purchase record.
    `reference_price_cents` / `reference_note` (S22-01) are a price reference *typed by
    the admin* for products with no history; it is never a price the app saw and the
    report keeps it apart from the teleyes saving.
    Money is integer cents; `purchased_at` is UTC.
    """

    __tablename__ = "purchase"
    __table_args__ = (
        CheckConstraint("price_cents > 0", name="ck_purchase_price_positive"),
        CheckConstraint(
            "reference_price_cents IS NULL OR reference_price_cents > 0",
            name="ck_purchase_reference_positive",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    price_cents: Mapped[int] = mapped_column()
    purchased_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    store: Mapped[str | None] = mapped_column(String(80), nullable=True)
    product_key: Mapped[str | None] = mapped_column(String(200), nullable=True, index=True)
    rule_id: Mapped[int | None] = mapped_column(nullable=True, index=True)
    reference_price_cents: Mapped[int | None] = mapped_column(nullable=True)
    reference_note: Mapped[str | None] = mapped_column(String(120), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(UTC)
    )
