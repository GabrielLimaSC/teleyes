"""add applied config snapshot to listener_control

Revision ID: d4b7e1a93c52
Revises: a7d4b2e91c35
Create Date: 2026-11-05 10:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "d4b7e1a93c52"
down_revision: Union[str, Sequence[str], None] = "a7d4b2e91c35"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """S25-F4: a light JSON snapshot of the config the listener applied, so the
    panel can say *what* changed since ("preço-alvo de X", "nova regra Y").

    Additive and nullable: until the next apply the column stays empty and the
    panel simply has no detail to show.
    """
    with op.batch_alter_table("listener_control") as batch:
        batch.add_column(sa.Column("applied_snapshot", sa.Text(), nullable=True))


def downgrade() -> None:
    """Drop the column; the panel falls back to the generic notice."""
    with op.batch_alter_table("listener_control") as batch:
        batch.drop_column("applied_snapshot")
