"""add feed settings table

Revision ID: 9b3e7c1a4f20
Revises: 43125d69024e
Create Date: 2026-09-23 16:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '9b3e7c1a4f20'
down_revision: Union[str, Sequence[str], None] = 'c776ebdea06b'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """S14-05 (F5): single-row feed display settings — for now just the
    "Agrupar duplicatas" toggle, defaulting to on. The row itself is created
    lazily by the app (`app.feed_settings`) on first read or write, not
    seeded here, same reasoning as `listener_control`.
    """
    op.create_table(
        'feed_settings',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('group_duplicates', sa.Boolean(), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint('id'),
    )


def downgrade() -> None:
    """Drop the feed_settings table; nothing else references it."""
    op.drop_table('feed_settings')
