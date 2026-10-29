"""add purchase table

Revision ID: f3a9d2b7c418
Revises: e5a7c1d93b46
Create Date: 2026-10-26 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "f3a9d2b7c418"
down_revision: Union[str, Sequence[str], None] = "e5a7c1d93b46"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """S19-04: purchases registered by the admin (cents, UTC). `product_key` and
    `rule_id` are optional links with no foreign key, and there is no Telegram
    content in this table.
    """
    op.create_table(
        "purchase",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("price_cents", sa.Integer(), nullable=False),
        sa.Column("purchased_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("store", sa.String(length=80), nullable=True),
        sa.Column("product_key", sa.String(length=200), nullable=True),
        sa.Column("rule_id", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("price_cents > 0", name="ck_purchase_price_positive"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_purchase_purchased_at", "purchase", ["purchased_at"], unique=False)
    op.create_index("ix_purchase_product_key", "purchase", ["product_key"], unique=False)
    op.create_index("ix_purchase_rule_id", "purchase", ["rule_id"], unique=False)


def downgrade() -> None:
    """Drop the purchase table; nothing else references it."""
    op.drop_index("ix_purchase_rule_id", table_name="purchase")
    op.drop_index("ix_purchase_product_key", table_name="purchase")
    op.drop_index("ix_purchase_purchased_at", table_name="purchase")
    op.drop_table("purchase")
