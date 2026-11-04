"""add purchase reference price and note

Revision ID: a7d4b2e91c35
Revises: c5a8e3d17f42
Create Date: 2026-11-04 15:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "a7d4b2e91c35"
down_revision: Union[str, Sequence[str], None] = "c5a8e3d17f42"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """S22-01: a price reference typed by the admin (not a price the app saw).

    Additive and nullable: existing rows keep both columns empty.
    """
    with op.batch_alter_table("purchase") as batch:
        batch.add_column(sa.Column("reference_price_cents", sa.Integer(), nullable=True))
        batch.add_column(sa.Column("reference_note", sa.String(length=120), nullable=True))
        batch.create_check_constraint(
            "ck_purchase_reference_positive",
            "reference_price_cents IS NULL OR reference_price_cents > 0",
        )


def downgrade() -> None:
    """Drop the two columns; the reference typed by the admin is lost."""
    with op.batch_alter_table("purchase") as batch:
        batch.drop_constraint("ck_purchase_reference_positive", type_="check")
        batch.drop_column("reference_note")
        batch.drop_column("reference_price_cents")
