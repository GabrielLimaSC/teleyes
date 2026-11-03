"""add metric_hourly, service_heartbeat and system_event

Revision ID: c5a8e3d17f42
Revises: b7d41e9a2c05
Create Date: 2026-11-04 09:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "c5a8e3d17f42"
down_revision: Union[str, Sequence[str], None] = "b7d41e9a2c05"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """S21-09: hourly metrics, service heartbeats and the event log (aggregates only).

    The history starts empty: nothing is back-filled, so the panel can say
    "coletando desde <data>" instead of inventing past hours.
    """
    op.create_table(
        "metric_hourly",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("hour_utc", sa.DateTime(timezone=True), nullable=False),
        sa.Column("source_id", sa.Integer(), nullable=True),
        sa.Column("reason", sa.String(length=32), nullable=False),
        sa.Column("count", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(["source_id"], ["source.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "hour_utc", "source_id", "reason", name="uq_metric_hourly_hour_source_reason"
        ),
    )
    op.create_index("ix_metric_hourly_hour_utc", "metric_hourly", ["hour_utc"])
    op.create_index(
        "uq_metric_hourly_hour_reason_no_source",
        "metric_hourly",
        ["hour_utc", "reason"],
        unique=True,
        sqlite_where=sa.text("source_id IS NULL"),
    )

    op.create_table(
        "service_heartbeat",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("service", sa.String(length=16), nullable=False),
        sa.Column("hour_utc", sa.DateTime(timezone=True), nullable=False),
        sa.Column("ok", sa.Integer(), nullable=False),
        sa.Column("total", sa.Integer(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("service", "hour_utc", name="uq_service_heartbeat_service_hour"),
    )
    op.create_index("ix_service_heartbeat_hour_utc", "service_heartbeat", ["hour_utc"])

    op.create_table(
        "system_event",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("kind", sa.String(length=24), nullable=False),
        sa.Column("summary", sa.String(length=160), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_system_event_at", "system_event", ["at"])


def downgrade() -> None:
    op.drop_index("ix_system_event_at", table_name="system_event")
    op.drop_table("system_event")
    op.drop_index("ix_service_heartbeat_hour_utc", table_name="service_heartbeat")
    op.drop_table("service_heartbeat")
    op.drop_index("uq_metric_hourly_hour_reason_no_source", table_name="metric_hourly")
    op.drop_index("ix_metric_hourly_hour_utc", table_name="metric_hourly")
    op.drop_table("metric_hourly")
