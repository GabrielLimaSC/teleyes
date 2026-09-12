from datetime import UTC, datetime
from enum import StrEnum

from sqlalchemy import DateTime, ForeignKey, Integer, String, UniqueConstraint, select
from sqlalchemy.orm import Mapped, Session, mapped_column

from models.base import Base


class MetricReason(StrEnum):
    """Fixed, categorical reasons a message was seen, discarded or failed.

    Only these values (never free text) can be stored — a rejected message's
    content has no path into `increment_counter`, so it can never end up in
    the database or in a log line built from this module.
    """

    SEEN = "vista"
    NO_TERM = "sem_termo"
    BLOCKED = "bloqueado"
    PRICE_ABOVE_CEILING = "preco_acima_teto"
    DELIVERY_FAILURE = "falha_entrega"


class MetricCounter(Base):
    __tablename__ = "metric_counter"
    __table_args__ = (
        UniqueConstraint("source_id", "reason", name="uq_metric_counter_source_reason"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    source_id: Mapped[int | None] = mapped_column(ForeignKey("source.id"), nullable=True)
    reason: Mapped[str] = mapped_column(String(32))
    count: Mapped[int] = mapped_column(Integer, default=0)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(UTC),
        onupdate=lambda: datetime.now(UTC),
    )


def _find(session: Session, reason: MetricReason, source_id: int | None) -> MetricCounter | None:
    stmt = select(MetricCounter).where(
        MetricCounter.reason == reason.value, MetricCounter.source_id == source_id
    )
    return session.scalar(stmt)


def increment_counter(
    session: Session, reason: MetricReason, *, source_id: int | None = None
) -> MetricCounter:
    """Increment the aggregate counter for `reason`, optionally scoped to a source.

    Takes only a fixed category and a numeric source id — never message
    content — so there is no way to accidentally persist rejected text here.
    """
    counter = _find(session, reason, source_id)
    if counter is None:
        counter = MetricCounter(source_id=source_id, reason=reason.value, count=0)
        session.add(counter)
    counter.count += 1
    session.flush()
    return counter


def get_count(session: Session, reason: MetricReason, *, source_id: int | None = None) -> int:
    counter = _find(session, reason, source_id)
    return counter.count if counter is not None else 0
