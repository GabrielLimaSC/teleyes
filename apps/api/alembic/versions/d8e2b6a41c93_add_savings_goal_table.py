"""add savings_goal table

Revision ID: d8e2b6a41c93
Revises: a3f9d2c8b714
Create Date: 2026-11-03 22:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "d8e2b6a41c93"
down_revision: Union[str, Sequence[str], None] = "a3f9d2c8b714"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """S21-08: single-row savings goal (cents + deadline date), no Telegram content."""
    op.create_table(
        "savings_goal",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("amount_cents", sa.Integer(), nullable=False),
        sa.Column("deadline", sa.Date(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("id = 1", name="ck_savings_goal_single_row"),
        sa.CheckConstraint("amount_cents > 0", name="ck_savings_goal_amount_positive"),
        sa.PrimaryKeyConstraint("id"),
    )


def downgrade() -> None:
    """Drop the savings_goal table; nothing else references it."""
    op.drop_table("savings_goal")
