from datetime import UTC, datetime

from sqlalchemy import Boolean, DateTime, String
from sqlalchemy.orm import Mapped, mapped_column

from models.base import Base


class Rule(Base):
    __tablename__ = "rule"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200))
    include_terms: Mapped[str] = mapped_column(String)
    exclude_terms: Mapped[str | None] = mapped_column(String, nullable=True)
    max_price_cents: Mapped[int | None] = mapped_column(nullable=True)
    # S14-02: the per-rule price alert target (F6), edited from the rule's
    # "Avise-me abaixo de" field. `None` means the rule has no target — a
    # match is never treated as a target hit without one
    # (`packages.rules.target.target_hit`). Always a strictly positive
    # amount when set, enforced by the CRUD (`repositories.rule_repo`).
    target_price_cents: Mapped[int | None] = mapped_column(nullable=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(UTC)
    )
