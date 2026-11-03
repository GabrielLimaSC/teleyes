"""add admin_session table

Revision ID: c9e2a4f6b813
Revises: b7d41e9a2c05
Create Date: 2026-11-03 15:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "c9e2a4f6b813"
down_revision: Union[str, Sequence[str], None] = "b7d41e9a2c05"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """S21-12: sessions survive an api restart; only the token hash is stored."""
    op.create_table(
        "admin_session",
        sa.Column("id_hash", sa.String(length=64), nullable=False),
        sa.Column("admin_id", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("remember", sa.Boolean(), nullable=False),
        sa.ForeignKeyConstraint(["admin_id"], ["admin.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id_hash"),
    )
    op.create_index("ix_admin_session_expires_at", "admin_session", ["expires_at"])


def downgrade() -> None:
    op.drop_index("ix_admin_session_expires_at", table_name="admin_session")
    op.drop_table("admin_session")
