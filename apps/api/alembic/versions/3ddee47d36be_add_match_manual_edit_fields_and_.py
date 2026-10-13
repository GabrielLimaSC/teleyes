"""add match manual edit fields and match_correction

Revision ID: 3ddee47d36be
Revises: 9b3e7c1a4f20
Create Date: 2026-09-24 14:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "3ddee47d36be"
# S14-05's feed_settings migration (9b3e7c1a4f20) merged first; this one was
# written in parallel off the same S14-02 head (c776ebdea06b), so it chains
# after 9b3e7c1a4f20 instead of needing a separate merge migration.
down_revision: Union[str, Sequence[str], None] = "9b3e7c1a4f20"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """S14-06 (F7): manual product edit + audit trail.

    `match` gains four nullable columns — `display_name`, `model_variant`,
    `price_source` (`"parsed"` | `"manual"` | `NULL`) and
    `original_price_cents` — every existing row keeps reading exactly as it
    did (an unedited match has all four `NULL`, same as "never touched"
    always meant). `match_correction` is a brand-new append-only audit
    table; nothing here backfills it, since no correction has ever happened
    before this migration runs.
    """
    with op.batch_alter_table("match", schema=None) as batch_op:
        batch_op.add_column(sa.Column("display_name", sa.String(length=120), nullable=True))
        batch_op.add_column(sa.Column("model_variant", sa.String(length=120), nullable=True))
        batch_op.add_column(sa.Column("price_source", sa.String(length=16), nullable=True))
        batch_op.add_column(sa.Column("original_price_cents", sa.Integer(), nullable=True))

    op.create_table(
        "match_correction",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("match_id", sa.Integer(), nullable=False),
        sa.Column("admin_id", sa.Integer(), nullable=False),
        sa.Column("changes", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["match_id"], ["match.id"]),
        sa.ForeignKeyConstraint(["admin_id"], ["admin.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_match_correction_match_id", "match_correction", ["match_id"], unique=False
    )


def downgrade() -> None:
    op.drop_index("ix_match_correction_match_id", table_name="match_correction")
    op.drop_table("match_correction")

    with op.batch_alter_table("match", schema=None) as batch_op:
        batch_op.drop_column("original_price_cents")
        batch_op.drop_column("price_source")
        batch_op.drop_column("model_variant")
        batch_op.drop_column("display_name")
