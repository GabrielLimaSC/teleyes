"""add rule target price and delivery kind

Revision ID: c776ebdea06b
Revises: 43125d69024e
Create Date: 2026-09-23 16:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "c776ebdea06b"
# S14-03's snooze migration (43125d69024e) and this one were both written in
# parallel off the same S14-01 head (7e2a9c4d1b35); S14-03 merged first, so
# this chains after it instead of needing a separate merge migration.
down_revision: Union[str, Sequence[str], None] = "43125d69024e"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """S14-02 (F6): `rule.target_price_cents` (nullable — most rules have no
    target) plus `delivery.kind` (`"immediate"` | `"target"`, defaulted to
    `"immediate"` for every existing row via `server_default` so legacy
    deliveries keep meaning exactly what they always meant). The old
    `(match_id, recipient_id)` unique constraint on `delivery` grows a third
    column, `kind`: a match that both repeats an already-notified promotion
    and hits its rule's target needs two rows for the same (match,
    recipient) — one suppressed `"immediate"` bookkeeping row and one real
    `"target"` send — and the old two-column constraint would have blocked
    that second row outright.
    """
    with op.batch_alter_table("rule", schema=None) as batch_op:
        batch_op.add_column(sa.Column("target_price_cents", sa.Integer(), nullable=True))

    with op.batch_alter_table("delivery", schema=None) as batch_op:
        batch_op.add_column(
            sa.Column(
                "kind", sa.String(length=16), nullable=False, server_default="immediate"
            )
        )
        batch_op.drop_constraint("uq_delivery_match_recipient", type_="unique")
        batch_op.create_unique_constraint(
            "uq_delivery_match_recipient_kind", ["match_id", "recipient_id", "kind"]
        )


def downgrade() -> None:
    """Drop the target price and the delivery channel distinction.

    The upgrade *relaxed* the unique constraint (a `"target"` row is now
    allowed to coexist with an `"immediate"` row for the same match+
    recipient — exactly the grouped-but-target-hit case S14-02 needs).
    Restoring the narrower two-column constraint can only ever collide with
    data created under that relaxed rule, so any such pair is collapsed
    first: the earliest row (by id) survives, matching "immediate is the
    original delivery, target is the later addition". A database with no
    such pair (including every empty test database) is untouched by the
    delete.
    """
    connection = op.get_bind()
    connection.execute(
        sa.text(
            "DELETE FROM delivery WHERE id NOT IN "
            "(SELECT MIN(id) FROM delivery GROUP BY match_id, recipient_id)"
        )
    )

    with op.batch_alter_table("delivery", schema=None) as batch_op:
        batch_op.drop_constraint("uq_delivery_match_recipient_kind", type_="unique")
        batch_op.create_unique_constraint(
            "uq_delivery_match_recipient", ["match_id", "recipient_id"]
        )
        batch_op.drop_column("kind")

    with op.batch_alter_table("rule", schema=None) as batch_op:
        batch_op.drop_column("target_price_cents")
