"""add cash and card price to match

Revision ID: c4ff94b64d59
Revises: b1c4e6f8a201
Create Date: 2026-09-14 11:43:33.258573

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "c4ff94b64d59"
down_revision: Union[str, Sequence[str], None] = "b1c4e6f8a201"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add nullable cash/card price columns; existing rows/price_cents untouched."""
    with op.batch_alter_table("match", schema=None) as batch_op:
        batch_op.add_column(sa.Column("price_cash_cents", sa.Integer(), nullable=True))
        batch_op.add_column(sa.Column("price_card_cents", sa.Integer(), nullable=True))


def downgrade() -> None:
    """Drop the cash/card price columns without changing price_cents."""
    with op.batch_alter_table("match", schema=None) as batch_op:
        batch_op.drop_column("price_card_cents")
        batch_op.drop_column("price_cash_cents")
