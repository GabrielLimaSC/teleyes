"""S21-09: hourly aggregates, service heartbeats and the event log.

Three small tables back the Saúde and Fontes screens:

- `metric_hourly`: the same categorical reasons as `metric_counter`, bucketed by UTC hour.
  It is written by `increment_counter`, in the same transaction.
- `service_heartbeat`: how many of an hour's samples found a service healthy.
- `system_event`: a short, human line per notable event.

Retention rule (CLAUDE.md): a rejected message never has its content persisted. Nothing
here accepts message text: the metric functions take a fixed reason and ids, heartbeats a
service name, and events a `kind` from a closed set plus a summary the *caller* builds
from allowed data only (a match title, counts, a recipient name). `SUMMARY_MAX_LENGTH`
bounds it. A test scans these tables' columns so no free-text column can appear unnoticed.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from enum import StrEnum

from sqlalchemy import (
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    UniqueConstraint,
    delete,
    func,
    select,
    text,
)
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Mapped, Session, mapped_column

from models.base import Base

logger = logging.getLogger(__name__)

RETENTION = timedelta(days=30)
SUMMARY_MAX_LENGTH = 160


class ServiceName(StrEnum):
    TELEGRAM = "telegram"
    BOT = "bot"
    LISTENER = "listener"
    SSE = "sse"
    DB = "db"


class EventKind(StrEnum):
    MATCH_TARGET = "match_target"
    SSE_RECONNECT = "sse_reconnect"
    RULES_APPLIED = "rules_applied"
    BACKUP = "backup"
    TEST_SEND = "test_send"
    LISTENER_RECONNECT = "listener_reconnect"
    DELIVERY_FAILURE = "delivery_failure"


class MetricHourly(Base):
    __tablename__ = "metric_hourly"
    __table_args__ = (
        UniqueConstraint(
            "hour_utc", "source_id", "reason", name="uq_metric_hourly_hour_source_reason"
        ),
        # SQLite treats NULLs as distinct in a UNIQUE constraint, so the no-source rows
        # (source_id IS NULL) get their own partial unique index to be upsertable.
        Index(
            "uq_metric_hourly_hour_reason_no_source",
            "hour_utc",
            "reason",
            unique=True,
            sqlite_where=text("source_id IS NULL"),
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    hour_utc: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    source_id: Mapped[int | None] = mapped_column(ForeignKey("source.id"), nullable=True)
    reason: Mapped[str] = mapped_column(String(32))
    count: Mapped[int] = mapped_column(Integer, default=0)


class ServiceHeartbeat(Base):
    __tablename__ = "service_heartbeat"
    __table_args__ = (
        UniqueConstraint("service", "hour_utc", name="uq_service_heartbeat_service_hour"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    service: Mapped[str] = mapped_column(String(16))
    hour_utc: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    # Samples of this hour that found the service healthy, out of `total`.
    ok: Mapped[int] = mapped_column(Integer, default=0)
    total: Mapped[int] = mapped_column(Integer, default=0)


class SystemEvent(Base):
    __tablename__ = "system_event"

    id: Mapped[int] = mapped_column(primary_key=True)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    kind: Mapped[str] = mapped_column(String(24))
    summary: Mapped[str] = mapped_column(String(SUMMARY_MAX_LENGTH))


def _as_utc(value: datetime) -> datetime:
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


def hour_floor(moment: datetime) -> datetime:
    """Truncate to the start of the UTC hour (a naive value is read as UTC)."""
    return _as_utc(moment).replace(minute=0, second=0, microsecond=0)


def increment_hourly(
    session: Session, reason: str, *, source_id: int | None = None, now: datetime | None = None
) -> None:
    """Atomic upsert of one count into the current UTC hour's bucket.

    Runs inside the caller's transaction (no commit here), so a rolled-back
    evaluation leaves no trace and two processes can never lose an increment.
    """
    hour = hour_floor(now or datetime.now(UTC))
    statement = sqlite_insert(MetricHourly).values(
        hour_utc=hour, source_id=source_id, reason=reason, count=1
    )
    if source_id is None:
        statement = statement.on_conflict_do_update(
            index_elements=["hour_utc", "reason"],
            index_where=MetricHourly.source_id.is_(None),
            set_={"count": MetricHourly.count + 1},
        )
    else:
        statement = statement.on_conflict_do_update(
            index_elements=["hour_utc", "source_id", "reason"],
            set_={"count": MetricHourly.count + 1},
        )
    session.execute(statement)


def record_heartbeat_sample(
    session: Session, service: str, healthy: bool, *, now: datetime | None = None
) -> None:
    """Add one sample (healthy or not) to the service's current-hour bucket. No commit."""
    hour = hour_floor(now or datetime.now(UTC))
    ok = 1 if healthy else 0
    session.execute(
        sqlite_insert(ServiceHeartbeat)
        .values(service=service, hour_utc=hour, ok=ok, total=1)
        .on_conflict_do_update(
            index_elements=["service", "hour_utc"],
            set_={"ok": ServiceHeartbeat.ok + ok, "total": ServiceHeartbeat.total + 1},
        )
    )


def clip_summary(summary: str) -> str:
    collapsed = " ".join(summary.split())
    if len(collapsed) <= SUMMARY_MAX_LENGTH:
        return collapsed
    return collapsed[: SUMMARY_MAX_LENGTH - 1].rstrip() + "…"


def record_system_event(
    session: Session,
    kind: EventKind,
    summary: str,
    *,
    at: datetime | None = None,
    dedupe_within: timedelta | None = None,
) -> bool:
    """Add an event line to the caller's transaction (no commit). The summary must be
    built only from allowed data (see module docstring); it is clipped to 160 chars.

    With `dedupe_within`, a same-kind event already logged inside that window makes this
    a no-op (returns False): a flapping connection must not flood the log.
    """
    moment = at or datetime.now(UTC)
    if dedupe_within is not None:
        latest = session.scalar(
            select(func.max(SystemEvent.at)).where(SystemEvent.kind == kind.value)
        )
        if latest is not None and moment - _as_utc(latest) < dedupe_within:
            return False
    session.add(SystemEvent(at=moment, kind=kind.value, summary=clip_summary(summary)))
    return True


def log_system_event(
    session_factory: Callable[[], Session],
    kind: EventKind,
    summary: str,
    *,
    dedupe_within: timedelta | None = None,
) -> None:
    """Own short transaction, never raises: an event line must not break its caller."""
    try:
        with session_factory() as session:
            if record_system_event(session, kind, summary, dedupe_within=dedupe_within):
                session.commit()
    except Exception as error:
        logger.warning(
            "event=system_event_failed kind=%s error_class=%s", kind.value, type(error).__name__
        )


def purge_old(session: Session, *, now: datetime | None = None) -> int:
    """Delete rows older than the 30-day retention from the three tables. Commits."""
    cutoff = (now or datetime.now(UTC)) - RETENTION
    removed = 0
    for table, column in (
        (MetricHourly, MetricHourly.hour_utc),
        (ServiceHeartbeat, ServiceHeartbeat.hour_utc),
        (SystemEvent, SystemEvent.at),
    ):
        result = session.execute(delete(table).where(column < cutoff))
        removed += result.rowcount or 0  # type: ignore[attr-defined]
    session.commit()
    return removed
