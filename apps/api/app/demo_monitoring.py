"""S21-09: fictional hourly metrics, heartbeats and events for the demo database.

Only the demo seed calls this (`seed_demo_database`); a real database is never touched.
Everything here is invented: hourly traffic follows a day/night curve, `vista` follows
the seeded matches themselves so the Fontes screen stays consistent, and the event log
reads like a quiet week. Telegram and the bot get no heartbeat, exactly like the real app
without credentials ("desligado de propósito", bars stay empty).
"""

from __future__ import annotations

import math
import random
from collections import defaultdict
from datetime import datetime, timedelta

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.pipeline import target_event_summary
from app.utc import ensure_utc
from models import Delivery, ListenerControl, Match, Recipient, Source
from packages.metrics.counters import MetricReason
from packages.metrics.hourly import (
    EventKind,
    MetricHourly,
    ServiceHeartbeat,
    ServiceName,
    SystemEvent,
    hour_floor,
)

HISTORY_DAYS = 7
HEARTBEAT_HOURS = 24
SAMPLES_PER_HOUR = 60
# (reason, lowest, highest) evaluations per source in the busiest hour.
DISCARD_PROFILE = (
    (MetricReason.NO_TERM, 90, 330),
    (MetricReason.BLOCKED, 2, 11),
    (MetricReason.PRICE_ABOVE_CEILING, 0, 5),
)
# A flaky hour for the live feed, so the bars are not suspiciously perfect.
SSE_DIP_HOURS_AGO = 17


def _daylight(hour_of_day: int) -> float:
    """0.12 at night, 1.0 around 15h UTC."""
    return 0.12 + 0.88 * (1 + math.sin((hour_of_day - 9) / 24 * 2 * math.pi)) / 2


def seed_monitoring(session: Session, now: datetime, rng: random.Random) -> None:
    for table in (MetricHourly, ServiceHeartbeat, SystemEvent):
        session.execute(delete(table))  # the seed pipeline wrote real-time rows: replace them
    _seed_hourly(session, now, rng)
    _seed_heartbeats(session, now)
    _seed_events(session, now)


def _seed_hourly(session: Session, now: datetime, rng: random.Random) -> None:
    current = hour_floor(now)
    start = current - timedelta(days=HISTORY_DAYS)
    seen: dict[tuple[int, datetime], int] = defaultdict(int)
    for source_id, matched_at in session.execute(
        select(Match.source_id, Match.matched_at).where(Match.matched_at >= start)
    ):
        seen[(source_id, hour_floor(matched_at))] += 1

    source_ids = [source.id for source in session.scalars(select(Source).order_by(Source.id))]
    for back in range(HISTORY_DAYS * 24, -1, -1):
        hour = current - timedelta(hours=back)
        weight = _daylight(hour.hour)
        for index, source_id in enumerate(source_ids):
            busy = 1.0 - 0.12 * index  # the first group is the busiest
            matches = seen.get((source_id, hour), 0)
            if matches:
                session.add(
                    MetricHourly(
                        hour_utc=hour,
                        source_id=source_id,
                        reason=MetricReason.SEEN.value,
                        count=matches,
                    )
                )
            for reason, low, high in DISCARD_PROFILE:
                count = round(rng.randint(low, high) * weight * busy)
                if count:
                    session.add(
                        MetricHourly(
                            hour_utc=hour, source_id=source_id, reason=reason.value, count=count
                        )
                    )
    session.flush()


def _seed_heartbeats(session: Session, now: datetime) -> None:
    current = hour_floor(now)
    for back in range(HEARTBEAT_HOURS):
        hour = current - timedelta(hours=back)
        total = now.minute + 1 if back == 0 else SAMPLES_PER_HOUR
        for service in (ServiceName.LISTENER, ServiceName.SSE, ServiceName.DB):
            ok = total
            if service is ServiceName.SSE and back == SSE_DIP_HOURS_AGO:
                ok = total - 4
            session.add(ServiceHeartbeat(service=service.value, hour_utc=hour, ok=ok, total=total))
    session.flush()


def _seed_events(session: Session, now: datetime) -> None:
    principal = session.scalar(select(Recipient).order_by(Recipient.id))
    control = session.get(ListenerControl, 1)
    events: list[tuple[datetime, EventKind, str]] = []

    target_rows = session.execute(
        select(Match, Delivery.delivered_at)
        .join(Delivery, Delivery.match_id == Match.id)
        .where(Delivery.kind == "target", Delivery.status == "sent")
        .order_by(Match.matched_at.desc())
        .limit(3)
    )
    for match, _delivered in target_rows:
        summary = target_event_summary(match)
        events.append((ensure_utc(match.matched_at), EventKind.MATCH_TARGET, summary))

    events.append(
        (
            now - timedelta(hours=9, minutes=41),
            EventKind.SSE_RECONNECT,
            "Feed reconectado — 3 eventos reenviados",
        )
    )
    events.append(
        (
            now - timedelta(hours=30, minutes=12),
            EventKind.LISTENER_RECONNECT,
            "Listener reconectou ao Telegram e recuperou as mensagens do intervalo",
        )
    )
    if control is not None and control.reload_applied_at is not None:
        events.append(
            (
                ensure_utc(control.reload_applied_at),
                EventKind.RULES_APPLIED,
                f"Regras aplicadas — {control.last_rules_loaded} regras, "
                f"{control.last_sources_loaded} fontes, {control.last_new_matches} matches "
                "novos no histórico",
            )
        )
    for days_back, size in ((0, "41,2"), (1, "41,0"), (2, "40,7")):
        at = (now - timedelta(days=days_back)).replace(hour=3, minute=0, second=0, microsecond=0)
        if at <= now:
            events.append((at, EventKind.BACKUP, f"Backup concluído ({size} MB)"))
    if principal is not None:
        events.append(
            (
                now - timedelta(days=1, hours=2, minutes=26),
                EventKind.TEST_SEND,
                f"Envio simulado para {principal.name} — modo demonstração",
            )
        )
    for at, kind, summary in events:
        session.add(SystemEvent(at=at, kind=kind.value, summary=summary))
    session.flush()
