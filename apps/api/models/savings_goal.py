from datetime import UTC, date, datetime

from sqlalchemy import CheckConstraint, Date, DateTime
from sqlalchemy.orm import Mapped, mapped_column

from models.base import Base


class SavingsGoal(Base):
    """S21-08: the single savings goal the admin set (amount in cents + deadline).

    One row, always `id = 1`. It holds no Telegram content. `created_at` is the start
    of the pace line (elapsed share of the time between it and `deadline`); editing the
    goal keeps it. `deadline` is a calendar date in the configured display timezone.
    """

    __tablename__ = "savings_goal"
    __table_args__ = (
        CheckConstraint("id = 1", name="ck_savings_goal_single_row"),
        CheckConstraint("amount_cents > 0", name="ck_savings_goal_amount_positive"),
    )

    id: Mapped[int] = mapped_column(primary_key=True, default=1)
    amount_cents: Mapped[int] = mapped_column()
    deadline: Mapped[date] = mapped_column(Date)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(UTC)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(UTC)
    )
