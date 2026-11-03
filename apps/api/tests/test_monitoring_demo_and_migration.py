"""S21-09 — the demo seed for the monitoring tables, and the migration that creates them."""

from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path
from subprocess import CompletedProcess

import pytest
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from sqlalchemy import func, select
from sqlalchemy.orm import Session, sessionmaker

from app.activity import read_history, read_source_activity
from app.demo_seed import seed_demo_database
from models.base import Base
from models.db import get_engine, get_sessionmaker
from packages.metrics.hourly import (
    SUMMARY_MAX_LENGTH,
    EventKind,
    MetricHourly,
    ServiceHeartbeat,
    SystemEvent,
)

NOW = datetime(2026, 6, 1, 15, 30, tzinfo=UTC)
AlembicRunner = Callable[..., CompletedProcess[str]]
NEW_TABLES = {"metric_hourly", "service_heartbeat", "system_event"}
PREVIOUS_HEAD = "c9e2a4f6b813"


@pytest.fixture(scope="module")
def seeded(tmp_path_factory: pytest.TempPathFactory) -> sessionmaker[Session]:
    import os
    import subprocess
    import sys

    path = tmp_path_factory.mktemp("demo-monitoring") / "demo.db"
    url = f"sqlite:///{path}"
    subprocess.run(
        [sys.executable, "-m", "alembic", "upgrade", "head"],
        cwd=Path(__file__).resolve().parents[1],
        env={**os.environ, "DATABASE_URL": url},
        check=True,
        capture_output=True,
    )
    factory = get_sessionmaker(get_engine(url))
    seed_demo_database(factory, now=NOW)
    return factory


def test_demo_seed_fills_seven_days_of_hourly_metrics(seeded: sessionmaker[Session]) -> None:
    with seeded() as session:
        history = read_history(session, NOW, 24)
        hours = session.scalar(select(func.count(func.distinct(MetricHourly.hour_utc))))
        assert hours == 7 * 24 + 1
        assert all(h.evaluated is not None and h.evaluated > 0 for h in history.collector_hours)
        assert history.collector_totals.evaluated > 1_000
        assert history.collector_totals.delivery_failures == 0

        activity = read_source_activity(session, NOW, 7, "America/Sao_Paulo")
        assert len(activity.sources) == 4
        for row in activity.sources:
            assert len(row.daily) == 7
            assert all(day.evaluated is not None and day.evaluated > 0 for day in row.daily)
            assert row.last_match_at is not None


def test_demo_hourly_matches_follow_the_seeded_matches(seeded: sessionmaker[Session]) -> None:
    with seeded() as session:
        from models import Match

        window_start = NOW.replace(minute=0, second=0, microsecond=0) - timedelta(days=7)
        seeded_matches = session.scalar(
            select(func.count()).select_from(Match).where(Match.matched_at >= window_start)
        )
        counted = session.scalar(
            select(func.coalesce(func.sum(MetricHourly.count), 0)).where(
                MetricHourly.reason == "vista"
            )
        )
        assert counted == seeded_matches


def test_demo_heartbeats_cover_listener_sse_db_but_not_telegram_or_bot(
    seeded: sessionmaker[Session],
) -> None:
    with seeded() as session:
        history = read_history(session, NOW, 24)
        by_service = {service.value: buckets for service, buckets in history.services.items()}

    assert all(b.total is None for b in by_service["telegram"])
    assert all(b.total is None for b in by_service["bot"])
    for name in ("listener", "db"):
        assert all(b.ok == b.total and b.total for b in by_service[name])
    sse = by_service["sse"]
    assert any(b.ok is not None and b.total is not None and b.ok < b.total for b in sse)
    assert history.coverage_since is not None


def test_demo_event_log_is_plausible_and_short(seeded: sessionmaker[Session]) -> None:
    with seeded() as session:
        events = list(session.scalars(select(SystemEvent).order_by(SystemEvent.at.desc())))

    assert {e.kind for e in events} == {kind.value for kind in EventKind} - {"delivery_failure"}
    assert all(0 < len(e.summary) <= SUMMARY_MAX_LENGTH for e in events)
    assert all(ensure_aware(e.at) <= NOW for e in events)
    assert any("modo demonstração" in e.summary for e in events)


def test_demo_seed_replaces_real_time_rows_written_by_the_pipeline(
    seeded: sessionmaker[Session],
) -> None:
    """The seed pipeline increments counters at the wall clock; none of that may remain."""
    with seeded() as session:
        newest = session.scalar(select(func.max(MetricHourly.hour_utc)))
        assert newest is not None
        assert newest.replace(tzinfo=UTC) <= NOW
        beats = session.scalar(select(func.count()).select_from(ServiceHeartbeat))
        assert beats == 24 * 3


def ensure_aware(value: datetime) -> datetime:
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value


# --- migration ---------------------------------------------------------------------


def _tables(url: str) -> set[str]:
    with get_engine(url).connect() as connection:
        rows = connection.exec_driver_sql(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ).fetchall()
    return {row[0] for row in rows}


def test_migration_up_and_down_is_symmetric(db_path: Path, alembic_runner: AlembicRunner) -> None:
    url = f"sqlite:///{db_path}"

    assert alembic_runner("upgrade", "head", database_url=url).returncode == 0
    assert NEW_TABLES <= _tables(url)

    down = alembic_runner("downgrade", PREVIOUS_HEAD, database_url=url)
    assert down.returncode == 0, down.stderr
    assert not (NEW_TABLES & _tables(url))
    assert "admin_session" in _tables(url)  # the previous revision is untouched

    again = alembic_runner("upgrade", "head", database_url=url)
    assert again.returncode == 0, again.stderr
    assert NEW_TABLES <= _tables(url)


def test_migration_matches_the_models(db_path: Path, alembic_runner: AlembicRunner) -> None:
    url = f"sqlite:///{db_path}"
    alembic_runner("upgrade", "head", database_url=url)

    with get_engine(url).connect() as connection:
        diff = compare_metadata(MigrationContext.configure(connection), Base.metadata)

    ours = [entry for entry in diff if any(name in repr(entry) for name in NEW_TABLES)]
    assert ours == []


def test_the_no_source_partial_unique_index_exists(
    db_path: Path, alembic_runner: AlembicRunner
) -> None:
    url = f"sqlite:///{db_path}"
    alembic_runner("upgrade", "head", database_url=url)

    with get_engine(url).connect() as connection:
        sql = connection.exec_driver_sql(
            "SELECT sql FROM sqlite_master WHERE name='uq_metric_hourly_hour_reason_no_source'"
        ).scalar()

    assert sql is not None and "WHERE source_id IS NULL" in sql
