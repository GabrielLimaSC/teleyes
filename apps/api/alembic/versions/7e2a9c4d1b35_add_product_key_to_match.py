"""add product key to match

Revision ID: 7e2a9c4d1b35
Revises: 34f9903299d5
Create Date: 2026-09-23 10:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

from packages.rules.product import product_key


# revision identifiers, used by Alembic.
revision: str = "7e2a9c4d1b35"
down_revision: Union[str, Sequence[str], None] = "34f9903299d5"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_BATCH_SIZE = 500


def upgrade() -> None:
    """Add the indexed product identity and backfill it from every existing message.

    `message_text` is only read, never rewritten. Uses the live
    `packages.rules.product.product_key`: a later change to that function needs
    its own backfill migration, never an edit here.
    """
    with op.batch_alter_table("match", schema=None) as batch_op:
        batch_op.add_column(sa.Column("product_key", sa.String(), nullable=True))
        batch_op.create_index("ix_match_product_key", ["product_key"], unique=False)

    connection = op.get_bind()
    match = sa.table(
        "match",
        sa.column("id", sa.Integer()),
        sa.column("message_text", sa.String()),
        sa.column("product_key", sa.String()),
    )
    last_id = 0
    while True:
        rows = connection.execute(
            sa.select(match.c.id, match.c.message_text)
            .where(match.c.id > last_id)
            .order_by(match.c.id)
            .limit(_BATCH_SIZE)
        ).fetchall()
        if not rows:
            break
        keyed = [{"row_id": row.id, "key": product_key(row.message_text)} for row in rows]
        updates = [update for update in keyed if update["key"] is not None]
        if updates:
            connection.execute(
                match.update()
                .where(match.c.id == sa.bindparam("row_id"))
                .values(product_key=sa.bindparam("key")),
                updates,
            )
        last_id = rows[-1].id


def downgrade() -> None:
    """Drop the product identity; match rows and message_text stay untouched."""
    with op.batch_alter_table("match", schema=None) as batch_op:
        batch_op.drop_index("ix_match_product_key")
        batch_op.drop_column("product_key")
