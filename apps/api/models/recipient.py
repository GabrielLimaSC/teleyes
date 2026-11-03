from datetime import UTC, datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from models.base import Base

RULES_MODE_ALL = "all"
RULES_MODE_SELECTED = "selected"


class Recipient(Base):
    __tablename__ = "recipient"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200))
    telegram_chat_id: Mapped[str] = mapped_column(String(64), unique=True)
    allowlisted: Mapped[bool] = mapped_column(Boolean, default=False)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    # S21-06 (F8): which rules reach this person. "all" = every rule, present and
    # future; "selected" = only the rules listed in `recipient_rule`. The two
    # `notify_*` flags choose which kinds of alert they get: a price-target hit
    # (immediate ping) and/or a common match (immediate or digest, per the
    # global digest setting, which stays the delivery channel).
    rules_mode: Mapped[str] = mapped_column(
        String(16), default=RULES_MODE_ALL, server_default=RULES_MODE_ALL
    )
    notify_target: Mapped[bool] = mapped_column(Boolean, default=True, server_default="1")
    notify_common: Mapped[bool] = mapped_column(Boolean, default=True, server_default="1")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(UTC)
    )


class RecipientRule(Base):
    """S21-06 (F8): a rule picked by a `rules_mode="selected"` recipient.

    SQLite foreign keys are not enforced in this project (no `PRAGMA
    foreign_keys`), so `ON DELETE CASCADE` is declared for the schema but the
    repositories also delete these rows explicitly when a rule or a recipient
    goes away.
    """

    __tablename__ = "recipient_rule"

    recipient_id: Mapped[int] = mapped_column(
        ForeignKey("recipient.id", ondelete="CASCADE"), primary_key=True
    )
    rule_id: Mapped[int] = mapped_column(
        ForeignKey("rule.id", ondelete="CASCADE"), primary_key=True, index=True
    )
