"""add recipient rules_mode, alert-type flags and recipient_rule

Revision ID: b7d41e9a2c05
Revises: a3f9d2c8b714
Create Date: 2026-11-03 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "b7d41e9a2c05"
down_revision: Union[str, Sequence[str], None] = "a3f9d2c8b714"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """S21-06 (F8): per-recipient rule selection and alert types.

    Every existing recipient becomes `all` + both alert types on, which is
    exactly what delivery did before (everyone got every rule, target and
    common alike). The global digest setting is not copied per person: it stays
    the delivery channel for a common match (digest or immediate), so nothing
    changes for anyone already using the app.
    """
    with op.batch_alter_table("recipient") as batch:
        batch.add_column(
            sa.Column("rules_mode", sa.String(length=16), nullable=False, server_default="all")
        )
        batch.add_column(
            sa.Column("notify_target", sa.Boolean(), nullable=False, server_default=sa.true())
        )
        batch.add_column(
            sa.Column("notify_common", sa.Boolean(), nullable=False, server_default=sa.true())
        )
    op.create_table(
        "recipient_rule",
        sa.Column("recipient_id", sa.Integer(), nullable=False),
        sa.Column("rule_id", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(["recipient_id"], ["recipient.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["rule_id"], ["rule.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("recipient_id", "rule_id"),
    )
    op.create_index("ix_recipient_rule_rule_id", "recipient_rule", ["rule_id"])


def downgrade() -> None:
    op.drop_index("ix_recipient_rule_rule_id", table_name="recipient_rule")
    op.drop_table("recipient_rule")
    with op.batch_alter_table("recipient") as batch:
        batch.drop_column("notify_common")
        batch.drop_column("notify_target")
        batch.drop_column("rules_mode")
