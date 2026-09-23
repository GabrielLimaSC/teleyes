"""add snooze table

Revision ID: 43125d69024e
Revises: 7e2a9c4d1b35
Create Date: 2026-09-23 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '43125d69024e'
down_revision: Union[str, Sequence[str], None] = '7e2a9c4d1b35'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """S14-03 (F3): a snooze silences delivery for one rule or one product
    until `until` (UTC). The check constraint keeps `scope` and the filled
    target column coherent; there is no cross-table FK to `match` since
    `product_key` is a derived string, not a row identity.
    """
    op.create_table(
        'snooze',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('scope', sa.String(length=16), nullable=False),
        sa.Column('rule_id', sa.Integer(), nullable=True),
        sa.Column('product_key', sa.String(), nullable=True),
        sa.Column('until', sa.DateTime(timezone=True), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("scope IN ('rule', 'product')", name='ck_snooze_scope'),
        sa.CheckConstraint(
            "(scope = 'rule' AND rule_id IS NOT NULL AND product_key IS NULL) OR "
            "(scope = 'product' AND product_key IS NOT NULL AND rule_id IS NULL)",
            name='ck_snooze_scope_target',
        ),
        sa.ForeignKeyConstraint(['rule_id'], ['rule.id']),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_snooze_rule_id', 'snooze', ['rule_id'], unique=False)
    op.create_index('ix_snooze_product_key', 'snooze', ['product_key'], unique=False)
    op.create_index('ix_snooze_until', 'snooze', ['until'], unique=False)


def downgrade() -> None:
    """Drop the snooze table; nothing else references it."""
    op.drop_index('ix_snooze_until', table_name='snooze')
    op.drop_index('ix_snooze_product_key', table_name='snooze')
    op.drop_index('ix_snooze_rule_id', table_name='snooze')
    op.drop_table('snooze')
