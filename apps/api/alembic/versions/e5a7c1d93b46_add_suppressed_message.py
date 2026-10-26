"""add suppressed_message

Revision ID: e5a7c1d93b46
Revises: bb1bdccda76e
Create Date: 2026-10-23 17:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "e5a7c1d93b46"
down_revision: Union[str, Sequence[str], None] = "bb1bdccda76e"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """S20-01: remembers the identity of a message whose match was deleted, so
    a historical re-scan does not recreate it."""
    op.create_table(
        "suppressed_message",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("source_id", sa.Integer(), nullable=False),
        sa.Column("telegram_message_id", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["source_id"], ["source.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "source_id", "telegram_message_id", name="uq_suppressed_source_message"
        ),
    )


def downgrade() -> None:
    op.drop_table("suppressed_message")
