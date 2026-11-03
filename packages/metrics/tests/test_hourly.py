import threading
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta, timezone
from pathlib import Path

import pytest
from sqlalchemy import Engine, String, Text, create_engine, select
from sqlalchemy.orm import Session, sessionmaker

from models.base import Base
from models.db import get_engine
from packages.metrics.counters import MetricReason, increment_counter
from packages.metrics.hourly import (
    RETENTION,
    SUMMARY_MAX_LENGTH,
    EventKind,
    MetricHourly,
    ServiceHeartbeat,
    SystemEvent,
    clip_summary,
    hour_floor,
    increment_hourly,
    log_system_event,
    purge_old,
    record_heartbeat_sample,
    record_system_event,
)

NOW = datetime(2026, 11, 3, 14, 37, 12, 500_000, tzinfo=UTC)
HOUR = datetime(2026, 11, 3, 14, 0, tzinfo=UTC)


@pytest.fixture
def engine() -> Engine:
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    return engine


@pytest.fixture
def session(engine: Engine) -> Iterator[Session]:
    with sessionmaker(bind=engine)() as session:
        yield session


def _rows(session: Session) -> list[tuple[datetime, int | None, str, int]]:
    return [
        (row.hour_utc.replace(tzinfo=UTC), row.source_id, row.reason, row.count)
        for row in session.scalars(select(MetricHourly).order_by(MetricHourly.id))
    ]


def test_hour_is_truncated_in_utc_whatever_the_input_zone() -> None:
    assert hour_floor(NOW) == HOUR
    sao_paulo = timezone(timedelta(hours=-3))
    assert hour_floor(NOW.astimezone(sao_paulo)) == HOUR  # 11:37 -03:00 is 14:37Z
    assert hour_floor(datetime(2026, 11, 3, 14, 59, 59)) == HOUR  # naive reads as UTC
    assert hour_floor(datetime(2026, 11, 3, 23, 30, tzinfo=sao_paulo)) == datetime(
        2026, 11, 4, 2, 0, tzinfo=UTC
    )


def test_increment_hourly_upserts_one_row_per_hour_source_reason(session: Session) -> None:
    for _ in range(3):
        increment_hourly(session, "vista", source_id=1, now=NOW)
    increment_hourly(session, "vista", source_id=2, now=NOW)
    increment_hourly(session, "sem_termo", source_id=1, now=NOW)
    increment_hourly(session, "vista", source_id=1, now=NOW + timedelta(hours=1))
    session.commit()

    assert _rows(session) == [
        (HOUR, 1, "vista", 3),
        (HOUR, 2, "vista", 1),
        (HOUR, 1, "sem_termo", 1),
        (HOUR + timedelta(hours=1), 1, "vista", 1),
    ]


def test_rows_without_a_source_are_upserted_too(session: Session) -> None:
    """SQLite treats NULLs as distinct in a UNIQUE constraint: the partial index covers it."""
    for _ in range(4):
        increment_hourly(session, "vista", source_id=None, now=NOW)
    session.commit()

    assert _rows(session) == [(HOUR, None, "vista", 4)]


def test_increment_counter_writes_total_and_hour_in_the_same_transaction(
    session: Session,
) -> None:
    increment_counter(session, MetricReason.SEEN, source_id=7)
    session.rollback()
    assert _rows(session) == []

    increment_counter(session, MetricReason.SEEN, source_id=7)
    increment_counter(session, MetricReason.SEEN, source_id=7)
    session.commit()
    assert [(row[1], row[2], row[3]) for row in _rows(session)] == [(7, "vista", 2)]


def test_concurrent_writers_never_lose_an_increment(tmp_path: Path) -> None:
    url = f"sqlite:///{tmp_path / 'concurrent.db'}"
    engine = get_engine(url)
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    errors: list[BaseException] = []

    def work() -> None:
        try:
            for _ in range(40):
                with factory() as session:
                    increment_hourly(session, "vista", source_id=1, now=NOW)
                    increment_hourly(session, "vista", source_id=None, now=NOW)
                    session.commit()
        except BaseException as error:  # pragma: no cover - reported below
            errors.append(error)

    threads = [threading.Thread(target=work) for _ in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert errors == []
    with factory() as session:
        assert sorted((row[1] is None, row[3]) for row in _rows(session)) == [
            (False, 160),
            (True, 160),
        ]


def test_heartbeat_samples_accumulate_ok_and_total(session: Session) -> None:
    record_heartbeat_sample(session, "listener", True, now=NOW)
    record_heartbeat_sample(session, "listener", True, now=NOW + timedelta(minutes=1))
    record_heartbeat_sample(session, "listener", False, now=NOW + timedelta(minutes=2))
    record_heartbeat_sample(session, "db", True, now=NOW)
    session.commit()

    rows = {
        (row.service, row.hour_utc.replace(tzinfo=UTC)): (row.ok, row.total)
        for row in session.scalars(select(ServiceHeartbeat))
    }
    assert rows == {("listener", HOUR): (2, 3), ("db", HOUR): (1, 1)}


def test_summary_is_clipped_to_160_characters(session: Session) -> None:
    long_title = "Placa de vídeo " * 40
    record_system_event(session, EventKind.MATCH_TARGET, long_title, at=NOW)
    session.commit()

    stored = session.scalars(select(SystemEvent)).one()
    assert len(stored.summary) <= SUMMARY_MAX_LENGTH
    assert stored.summary.endswith("…")
    assert clip_summary("a\n  b") == "a b"


def test_dedupe_window_collapses_a_flapping_event(session: Session) -> None:
    assert record_system_event(
        session, EventKind.SSE_RECONNECT, "a", at=NOW, dedupe_within=timedelta(minutes=1)
    )
    session.commit()
    assert not record_system_event(
        session,
        EventKind.SSE_RECONNECT,
        "b",
        at=NOW + timedelta(seconds=30),
        dedupe_within=timedelta(minutes=1),
    )
    assert record_system_event(
        session,
        EventKind.LISTENER_RECONNECT,
        "other kind",
        at=NOW + timedelta(seconds=30),
        dedupe_within=timedelta(minutes=1),
    )
    assert record_system_event(
        session,
        EventKind.SSE_RECONNECT,
        "later",
        at=NOW + timedelta(minutes=2),
        dedupe_within=timedelta(minutes=1),
    )


def test_log_system_event_never_raises(engine: Engine) -> None:
    def broken_factory() -> Session:
        raise RuntimeError("database gone")

    log_system_event(broken_factory, EventKind.BACKUP, "x")  # must not propagate

    factory = sessionmaker(bind=engine)
    log_system_event(factory, EventKind.BACKUP, "Backup concluído (1,0 MB)")
    with factory() as session:
        assert session.scalars(select(SystemEvent.summary)).all() == ["Backup concluído (1,0 MB)"]


def test_retention_removes_only_rows_older_than_30_days(session: Session) -> None:
    old = NOW - RETENTION - timedelta(hours=1)
    fresh = NOW - RETENTION + timedelta(hours=1)
    for moment in (old, fresh):
        increment_hourly(session, "vista", source_id=1, now=moment)
        record_heartbeat_sample(session, "db", True, now=moment)
        record_system_event(session, EventKind.BACKUP, "b", at=moment)
    session.commit()

    assert purge_old(session, now=NOW) == 3

    assert len(_rows(session)) == 1
    assert len(session.scalars(select(ServiceHeartbeat)).all()) == 1
    assert len(session.scalars(select(SystemEvent)).all()) == 1


def test_new_tables_have_no_free_text_columns() -> None:
    """Retention rule: nothing here can hold a rejected message's content.

    Every string column must be an explicitly known short categorical (or the bounded
    event summary); no `Text`, and no new string column slips in without this test
    being updated on purpose."""
    allowed = {
        "metric_hourly": {"reason": 32},
        "service_heartbeat": {"service": 16},
        "system_event": {"kind": 24, "summary": SUMMARY_MAX_LENGTH},
    }
    for table_name, string_columns in allowed.items():
        table = Base.metadata.tables[table_name]
        found: dict[str, int] = {}
        for column in table.columns:
            assert not isinstance(column.type, Text), f"{table_name}.{column.name} is Text"
            if isinstance(column.type, String):
                assert column.type.length is not None
                found[column.name] = column.type.length
        assert found == string_columns, table_name


def test_event_kinds_match_the_closed_set() -> None:
    assert {kind.value for kind in EventKind} == {
        "match_target",
        "sse_reconnect",
        "rules_applied",
        "backup",
        "test_send",
        "listener_reconnect",
        "delivery_failure",
    }


def test_increment_signature_cannot_accept_message_text() -> None:
    import inspect

    assert set(inspect.signature(increment_hourly).parameters) == {
        "session",
        "reason",
        "source_id",
        "now",
    }
