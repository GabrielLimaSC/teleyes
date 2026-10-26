"""add setup wizard tables

Revision ID: a3f9d2c8b714
Revises: f3a9d2b7c418
Create Date: 2026-10-26 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "a3f9d2c8b714"
down_revision: Union[str, Sequence[str], None] = "f3a9d2b7c418"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """S19-02: audit events, the dialog-scan mailbox and its result."""
    op.create_table(
        "security_event",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("kind", sa.String(length=48), nullable=False),
        sa.Column("detail", sa.String(length=48), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "dialog_scan",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("state", sa.String(length=16), nullable=False),
        sa.Column("requested_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("error", sa.String(length=200), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "telegram_dialog",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("telegram_chat_id", sa.String(length=64), nullable=False),
        sa.Column("title", sa.String(length=300), nullable=False),
        sa.Column("kind", sa.String(length=16), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("telegram_chat_id"),
    )


def downgrade() -> None:
    op.drop_table("telegram_dialog")
    op.drop_table("dialog_scan")
    op.drop_table("security_event")
