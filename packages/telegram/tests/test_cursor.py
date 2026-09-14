from collections.abc import Iterator
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from models import Source
from models.base import Base
from packages.telegram.adapter import AdapterState, TelegramAdapter
from packages.telegram.cursor import (
    TelegramMessage,
    advance_cursor,
    backfill_since_cursor,
    get_cursor,
    has_cursor,
)
from packages.telegram.fakes import FakeTelegramClient


async def fake_sleep(seconds: float) -> None:
    return None


@pytest.fixture
def session() -> Iterator[Session]:
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    with sessionmaker(bind=engine)() as session:
        yield session


@pytest.fixture
def source_id(session: Session) -> int:
    source = Source(name="Grupo Teste", telegram_chat_id="-100123")
    session.add(source)
    session.flush()
    return source.id


def _msg(message_id: int, minutes_ago: float = 0.0) -> TelegramMessage:
    return TelegramMessage(
        id=message_id,
        text=f"mensagem {message_id}",
        date=datetime.now(UTC) - timedelta(minutes=minutes_ago),
    )


async def test_get_cursor_defaults_to_zero_for_new_source(session: Session, source_id: int) -> None:
    assert get_cursor(session, source_id) == 0


async def test_has_cursor_distinguishes_no_row_from_a_real_value_of_zero(
    session: Session, source_id: int
) -> None:
    """S6-04: `get_cursor`'s `0` sentinel alone cannot tell a brand-new source
    (never live-processed, no row at all) apart from a source whose real
    persisted cursor happens to be `0` — `has_cursor` is what the listener's
    startup sequencing must check instead.
    """
    assert has_cursor(session, source_id) is False

    advance_cursor(session, source_id, 0)

    assert get_cursor(session, source_id) == 0
    assert has_cursor(session, source_id) is True


async def test_backfill_returns_new_messages_and_advances_cursor(
    session: Session, source_id: int
) -> None:
    client = FakeTelegramClient(messages=[_msg(1), _msg(2), _msg(3)])

    result = await backfill_since_cursor(session, client, source_id, "-100123")

    assert [m.id for m in result] == [1, 2, 3]
    assert get_cursor(session, source_id) == 3


async def test_reconnect_backfill_skips_already_processed_messages(
    session: Session, source_id: int
) -> None:
    client = FakeTelegramClient(messages=[_msg(1), _msg(2), _msg(3)])
    await backfill_since_cursor(session, client, source_id, "-100123")

    # Messages 4-6 arrived while "disconnected"; the client's history now has them too.
    client.messages.extend([_msg(4), _msg(5), _msg(6)])

    result = await backfill_since_cursor(session, client, source_id, "-100123")

    assert [m.id for m in result] == [4, 5, 6]
    assert get_cursor(session, source_id) == 6

    # Reconnecting again with nothing new must not reprocess anything.
    repeat = await backfill_since_cursor(session, client, source_id, "-100123")
    assert repeat == []
    assert get_cursor(session, source_id) == 6


async def test_backfill_respects_max_messages_limit(session: Session, source_id: int) -> None:
    client = FakeTelegramClient(messages=[_msg(i) for i in range(1, 11)])

    result = await backfill_since_cursor(session, client, source_id, "-100123", max_messages=3)

    assert [m.id for m in result] == [1, 2, 3]
    assert get_cursor(session, source_id) == 3


async def test_backfill_respects_max_age(session: Session, source_id: int) -> None:
    now = datetime.now(UTC)
    client = FakeTelegramClient(
        messages=[_msg(1, minutes_ago=120), _msg(2, minutes_ago=5), _msg(3, minutes_ago=1)]
    )

    result = await backfill_since_cursor(
        session, client, source_id, "-100123", max_age=timedelta(minutes=30), now=now
    )

    assert [m.id for m in result] == [2, 3]
    assert get_cursor(session, source_id) == 3


async def test_backfill_integrates_with_adapter_reconnect_flow(
    session: Session, source_id: int
) -> None:
    client = FakeTelegramClient(messages=[_msg(1), _msg(2)])
    adapter = TelegramAdapter(api_id=1, api_hash="hash", client=client, sleep=fake_sleep)

    assert await adapter.connect() is AdapterState.CONNECTED
    await backfill_since_cursor(session, client, source_id, "-100123")
    assert get_cursor(session, source_id) == 2

    await adapter.disconnect()
    assert adapter.state is AdapterState.RECONNECTING

    # Messages 3-4 arrive while disconnected.
    client.messages.extend([_msg(3), _msg(4)])

    assert await adapter.reconnect() is AdapterState.CONNECTED
    result = await backfill_since_cursor(session, client, source_id, "-100123")

    assert [m.id for m in result] == [3, 4]
    assert get_cursor(session, source_id) == 4
