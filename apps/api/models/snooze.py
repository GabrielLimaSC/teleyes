from datetime import UTC, datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from models.base import Base


class Snooze(Base):
    """S14-03 (F3): silences delivery for one rule or one product until `until`.

    Silencing only ever suppresses the `Delivery` — see
    `app.delivery_policy.is_snoozed`, the pipeline's only reader of this
    table. The match itself is always persisted and published on SSE exactly
    as if nothing were snoozed. There is no cleanup job for an expired row
    (S14 decision): it is simply ignored by every read once `until` is in
    the past, and only ever removed by "Reativar" (`DELETE /snoozes/{id}`)
    or replaced by a new snooze of the same target.
    """

    __tablename__ = "snooze"
    __table_args__ = (
        CheckConstraint("scope IN ('rule', 'product')", name="ck_snooze_scope"),
        CheckConstraint(
            "(scope = 'rule' AND rule_id IS NOT NULL AND product_key IS NULL) OR "
            "(scope = 'product' AND product_key IS NOT NULL AND rule_id IS NULL)",
            name="ck_snooze_scope_target",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    scope: Mapped[str] = mapped_column(String(16))
    rule_id: Mapped[int | None] = mapped_column(ForeignKey("rule.id"), nullable=True, index=True)
    product_key: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    until: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(UTC)
    )
