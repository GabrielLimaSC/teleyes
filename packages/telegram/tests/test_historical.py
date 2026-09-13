from datetime import UTC, datetime, timedelta

from packages.telegram.cursor import TelegramMessage
from packages.telegram.fakes import FakeTelegramClient
from packages.telegram.historical import fetch_messages_since


def _msg(message_id: int, *, date: datetime) -> TelegramMessage:
    return TelegramMessage(id=message_id, text=f"mensagem {message_id}", date=date)


async def test_fetch_messages_since_excludes_messages_at_or_beyond_24h() -> None:
    now = datetime(2026, 9, 13, 12, 0, tzinfo=UTC)
    client = FakeTelegramClient(
        messages=[
            _msg(1, date=now - timedelta(hours=24)),  # exactly 24h old: excluded
            _msg(2, date=now - timedelta(hours=24) + timedelta(seconds=1)),  # 1s inside: included
        ]
    )

    result = await fetch_messages_since(client, "-100123", window=timedelta(hours=24), before=now)

    assert [m.id for m in result] == [2]


async def test_fetch_messages_since_has_no_fixed_message_count_ceiling() -> None:
    now = datetime(2026, 9, 13, 12, 0, tzinfo=UTC)
    # Well above the 100-message cap the reconnect/cursor backfill path uses —
    # the historical scan (S6-02) is bounded only by the time window, never a
    # fixed count.
    client = FakeTelegramClient(
        messages=[_msg(i, date=now - timedelta(minutes=i)) for i in range(1, 151)]
    )

    result = await fetch_messages_since(client, "-100123", window=timedelta(hours=24), before=now)

    assert len(result) == 150


async def test_fetch_messages_since_excludes_messages_at_or_after_before() -> None:
    """A message that arrived at/after the scan's own start instant (`before`)
    is never historical — it belongs to the live handler, which is registered
    before this scan starts (S6-02).
    """
    now = datetime(2026, 9, 13, 12, 0, tzinfo=UTC)
    client = FakeTelegramClient(
        messages=[
            _msg(1, date=now - timedelta(minutes=1)),  # before the scan started: historical
            _msg(2, date=now),  # exactly at scan start: excluded, live's responsibility
            _msg(3, date=now + timedelta(seconds=1)),  # after scan started: excluded
        ]
    )

    result = await fetch_messages_since(client, "-100123", window=timedelta(hours=24), before=now)

    assert [m.id for m in result] == [1]


async def test_fetch_messages_since_never_reads_or_needs_a_cursor() -> None:
    """No `ProcessingCursor` argument exists in this function's signature at
    all — a historical scan must be independent of the live/reconnect cursor
    (S6-02), unlike `packages.telegram.cursor.backfill_since_cursor`.
    """
    now = datetime(2026, 9, 13, 12, 0, tzinfo=UTC)
    client = FakeTelegramClient(messages=[_msg(1, date=now - timedelta(hours=1))])

    first = await fetch_messages_since(client, "-100123", window=timedelta(hours=24), before=now)
    second = await fetch_messages_since(client, "-100123", window=timedelta(hours=24), before=now)

    assert [m.id for m in first] == [1]
    assert [m.id for m in second] == [1]
