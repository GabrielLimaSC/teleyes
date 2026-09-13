"""add telegram message identity to match

Revision ID: b1c4e6f8a201
Revises: 6431f12a4852
Create Date: 2026-09-13 14:30:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "b1c4e6f8a201"
down_revision: Union[str, Sequence[str], None] = "6431f12a4852"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Persist real Telegram ids while preserving legacy rows as NULL."""
    with op.batch_alter_table("match", schema=None) as batch_op:
        batch_op.add_column(sa.Column("telegram_message_id", sa.Integer(), nullable=True))
        batch_op.create_unique_constraint(
            "uq_match_source_rule_telegram_message",
            ["source_id", "rule_id", "telegram_message_id"],
        )


def downgrade() -> None:
    """Remove Telegram identity without changing the remaining match data."""
    with op.batch_alter_table("match", schema=None) as batch_op:
        batch_op.drop_constraint("uq_match_source_rule_telegram_message", type_="unique")
        batch_op.drop_column("telegram_message_id")
