"""S21-09: read side of the hourly metrics, service heartbeats and event log.

The one rule that matters here: an hour or a day nobody measured is `None`, never `0`
and never "ok". The history starts empty at deploy, and the panel must say "coletando"
for those buckets instead of painting them green. A *measured* quiet hour is `0`.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import func, select
from sqlalchemy.orm import InstrumentedAttribute, Session

from app.utc import ensure_utc
from models import Match, Source
from packages.metrics.counters import MetricReason
from packages.metrics.hourly import (
    MetricHourly,
    ServiceHeartbeat,
    ServiceName,
    SystemEvent,
    hour_floor,
)

SERVICE_ORDER: tuple[ServiceName, ...] = (
    ServiceName.TELEGRAM,
    ServiceName.BOT,
    ServiceName.LISTENER,
    ServiceName.SSE,
    ServiceName.DB,
)
DISCARD_REASONS = (
    MetricReason.NO_TERM.value,
    MetricReason.BLOCKED.value,
    MetricReason.PRICE_ABOVE_CEILING.value,
)
SEEN = MetricReason.SEEN.value
FAILURE = MetricReason.DELIVERY_FAILURE.value


@dataclass(frozen=True)
class HeartbeatBucket:
    hour: datetime
    ok: int | None
    total: int | None


@dataclass(frozen=True)
class CollectorHour:
    hour: datetime
    seen: int | None
    evaluated: int | None


@dataclass(frozen=True)
class CollectorTotals:
    seen: int
    discarded: int
    evaluated: int
    delivery_failures: int
    delivery_failures_last_hour: int


@dataclass(frozen=True)
class HistorySnapshot:
    hours: int
    coverage_since: datetime | None
    services: dict[ServiceName, list[HeartbeatBucket]]
    collector_coverage_since: datetime | None
    collector_hours: list[CollectorHour]
    collector_totals: CollectorTotals


def window_hours(now: datetime, hours: int) -> list[datetime]:
    """The `hours` UTC hour starts ending with the current one, oldest first."""
    current = hour_floor(now)
    return [current - timedelta(hours=offset) for offset in range(hours - 1, -1, -1)]


def _min_hour(session: Session, column: InstrumentedAttribute[datetime]) -> datetime | None:
    value = session.scalar(select(func.min(column)))
    return None if value is None else ensure_utc(value)


def read_history(session: Session, now: datetime, hours: int) -> HistorySnapshot:
    starts = window_hours(now, hours)
    first = starts[0]

    beats: dict[tuple[str, datetime], tuple[int, int]] = {}
    for beat in session.scalars(select(ServiceHeartbeat).where(ServiceHeartbeat.hour_utc >= first)):
        beats[(beat.service, ensure_utc(beat.hour_utc))] = (beat.ok, beat.total)
    services = {
        service: [
            HeartbeatBucket(hour, *_split(beats.get((service.value, hour)))) for hour in starts
        ]
        for service in SERVICE_ORDER
    }

    per_hour: dict[datetime, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    for hour, reason, total in session.execute(
        select(MetricHourly.hour_utc, MetricHourly.reason, func.sum(MetricHourly.count))
        .where(MetricHourly.hour_utc >= first)
        .group_by(MetricHourly.hour_utc, MetricHourly.reason)
    ):
        per_hour[ensure_utc(hour)][reason] += int(total or 0)

    listener_up = {
        hour
        for (service, hour), (_, total) in beats.items()
        if service == ServiceName.LISTENER.value and total > 0
    }
    collector_hours: list[CollectorHour] = []
    for hour in starts:
        counts = per_hour.get(hour)
        if counts is None and hour not in listener_up:
            collector_hours.append(CollectorHour(hour, None, None))
            continue
        counts = counts or {}
        seen = counts.get(SEEN, 0)
        collector_hours.append(
            CollectorHour(hour, seen, seen + sum(counts.get(r, 0) for r in DISCARD_REASONS))
        )

    current = starts[-1]
    seen_total = sum(c.seen or 0 for c in collector_hours)
    discarded = sum(sum(counts.get(r, 0) for r in DISCARD_REASONS) for counts in per_hour.values())
    totals = CollectorTotals(
        seen=seen_total,
        discarded=discarded,
        evaluated=seen_total + discarded,
        delivery_failures=sum(counts.get(FAILURE, 0) for counts in per_hour.values()),
        delivery_failures_last_hour=per_hour.get(current, {}).get(FAILURE, 0),
    )
    return HistorySnapshot(
        hours=hours,
        coverage_since=_min_hour(session, ServiceHeartbeat.hour_utc),
        services=services,
        collector_coverage_since=_min_hour(session, MetricHourly.hour_utc),
        collector_hours=collector_hours,
        collector_totals=totals,
    )


def _split(pair: tuple[int, int] | None) -> tuple[int | None, int | None]:
    return (None, None) if pair is None else pair


def read_events(session: Session, limit: int) -> list[SystemEvent]:
    statement = select(SystemEvent).order_by(SystemEvent.at.desc(), SystemEvent.id.desc())
    return list(session.scalars(statement.limit(limit)))


@dataclass(frozen=True)
class DayActivity:
    day: date
    evaluated: int | None


@dataclass(frozen=True)
class SourceActivityRow:
    source_id: int
    name: str
    active: bool
    daily: list[DayActivity]
    matches: int
    last_match_at: datetime | None


@dataclass(frozen=True)
class ActivitySnapshot:
    days: int
    coverage_since: datetime | None
    sources: list[SourceActivityRow]


def read_source_activity(
    session: Session, now: datetime, days: int, display_timezone: str
) -> ActivitySnapshot:
    zone = ZoneInfo(display_timezone)
    today = now.astimezone(zone).date()
    day_list = [today - timedelta(days=offset) for offset in range(days - 1, -1, -1)]

    def start_of(day: date) -> datetime:
        return datetime.combine(day, datetime.min.time(), tzinfo=zone).astimezone(UTC)

    bounds = [(start_of(day), start_of(day + timedelta(days=1))) for day in day_list]
    window_start = bounds[0][0]
    coverage = _min_hour(session, MetricHourly.hour_utc)

    per_source_day: dict[int, dict[date, int]] = defaultdict(lambda: defaultdict(int))
    for source_id, hour, total in session.execute(
        select(MetricHourly.source_id, MetricHourly.hour_utc, func.sum(MetricHourly.count))
        .where(
            MetricHourly.hour_utc >= window_start,
            MetricHourly.source_id.is_not(None),
            MetricHourly.reason.in_((SEEN, *DISCARD_REASONS)),
        )
        .group_by(MetricHourly.source_id, MetricHourly.hour_utc)
    ):
        local_day = ensure_utc(hour).astimezone(zone).date()
        per_source_day[source_id][local_day] += int(total or 0)

    matches_in_window = dict(
        session.execute(
            select(Match.source_id, func.count())
            .where(Match.matched_at >= window_start)
            .group_by(Match.source_id)
        ).tuples()
    )
    last_match = {
        source_id: ensure_utc(last)
        for source_id, last in session.execute(
            select(Match.source_id, func.max(Match.matched_at)).group_by(Match.source_id)
        ).tuples()
        if last is not None
    }

    rows: list[SourceActivityRow] = []
    for source in session.scalars(select(Source).order_by(Source.id)):
        counts = per_source_day.get(source.id, {})
        daily = [
            DayActivity(
                day,
                # Before the first measured hour nobody was counting: unknown, not zero.
                None if coverage is None or end <= coverage else counts.get(day, 0),
            )
            for day, (_, end) in zip(day_list, bounds, strict=True)
        ]
        rows.append(
            SourceActivityRow(
                source_id=source.id,
                name=source.name,
                active=source.active,
                daily=daily,
                matches=matches_in_window.get(source.id, 0),
                last_match_at=last_match.get(source.id),
            )
        )
    return ActivitySnapshot(days=days, coverage_since=coverage, sources=rows)
