"""add digest settings and digest run tables

Revision ID: bb1bdccda76e
Revises: c776ebdea06b
Create Date: 2026-09-24 13:57:12.041051

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "bb1bdccda76e"
down_revision: Union[str, Sequence[str], None] = "c776ebdea06b"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """S14-04 (F4): the daily digest's two tables.

    `digest_settings` is the single configuration row (`id` always 1, enforced
    in code, not a check constraint — mirrors `listener_control`'s own
    single-row mailbox, which does the same). `digest_run` is the idempotency
    marker: one row per local calendar day the digest scheduler actually ran,
    keyed on `local_date` itself (no separate id) so "did today already run"
    is a single primary-key lookup, never a query with its own race window.
    """
    op.create_table(
        "digest_settings",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("send_at_local", sa.String(length=5), nullable=False),
        sa.Column("top_n", sa.Integer(), nullable=False),
        sa.Column("mute_individual", sa.Boolean(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "digest_run",
        sa.Column("local_date", sa.Date(), nullable=False),
        sa.Column("ran_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("items_sent", sa.Integer(), nullable=False),
        sa.Column("items_skipped", sa.Integer(), nullable=False),
        sa.PrimaryKeyConstraint("local_date"),
    )


def downgrade() -> None:
    op.drop_table("digest_run")
    op.drop_table("digest_settings")
