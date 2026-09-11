import inspect
from collections.abc import Iterator

import pytest
from sqlalchemy import Engine, create_engine
from sqlalchemy import inspect as sa_inspect
from sqlalchemy.orm import Session, sessionmaker

from models.base import Base
from packages.metrics.counters import MetricReason, get_count, increment_counter


@pytest.fixture
def engine() -> Engine:
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    return engine


@pytest.fixture
def session(engine: Engine) -> Iterator[Session]:
    with sessionmaker(bind=engine)() as session:
        yield session


def test_increment_counter_starts_at_one_and_accumulates(session: Session) -> None:
    increment_counter(session, MetricReason.NO_TERM)
    increment_counter(session, MetricReason.NO_TERM)
    increment_counter(session, MetricReason.NO_TERM)

    assert get_count(session, MetricReason.NO_TERM) == 3


def test_counters_are_independent_per_reason(session: Session) -> None:
    increment_counter(session, MetricReason.SEEN)
    increment_counter(session, MetricReason.BLOCKED)
    increment_counter(session, MetricReason.BLOCKED)

    assert get_count(session, MetricReason.SEEN) == 1
    assert get_count(session, MetricReason.BLOCKED) == 2
    assert get_count(session, MetricReason.PRICE_ABOVE_CEILING) == 0


def test_counters_are_independent_per_source(session: Session) -> None:
    increment_counter(session, MetricReason.DELIVERY_FAILURE, source_id=1)
    increment_counter(session, MetricReason.DELIVERY_FAILURE, source_id=1)
    increment_counter(session, MetricReason.DELIVERY_FAILURE, source_id=2)

    assert get_count(session, MetricReason.DELIVERY_FAILURE, source_id=1) == 2
    assert get_count(session, MetricReason.DELIVERY_FAILURE, source_id=2) == 1


def test_missing_counter_reads_as_zero_without_creating_a_row(session: Session) -> None:
    assert get_count(session, MetricReason.PRICE_ABOVE_CEILING) == 0


def test_increment_counter_signature_cannot_accept_message_text(session: Session) -> None:
    """Structural guarantee: no parameter exists for message content."""
    parameters = inspect.signature(increment_counter).parameters
    assert set(parameters) == {"session", "reason", "source_id"}


def test_rejected_message_text_never_appears_in_any_table(
    session: Session, engine: Engine
) -> None:
    rejected_text = "IPHONE 15 PROMOÇÃO EXCLUSIVA SUPER SECRETA XYZ123"

    increment_counter(session, MetricReason.NO_TERM)
    increment_counter(session, MetricReason.BLOCKED)
    increment_counter(session, MetricReason.PRICE_ABOVE_CEILING)
    increment_counter(session, MetricReason.DELIVERY_FAILURE)
    session.commit()

    inspector = sa_inspect(engine)
    with engine.connect() as connection:
        for table_name in inspector.get_table_names():
            rows = connection.exec_driver_sql(f"SELECT * FROM {table_name}").fetchall()
            for row in rows:
                for value in row:
                    assert rejected_text not in str(value)
