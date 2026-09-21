from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta, timezone

from packages.telegram.telethon_client import (
    TelethonMessageFetcher,
    normalize_telegram_datetime,
    to_telegram_message,
)


class FakeTelethonMessage:
    def __init__(self, *, date: datetime) -> None:
        self.id = 73
        self.text: str | None = "promo"
        self.date = date


def test_telethon_message_keeps_real_event_timestamp_normalized_to_utc() -> None:
    event_date = datetime(2026, 9, 13, 15, 30, tzinfo=timezone(timedelta(hours=3)))

    message = to_telegram_message(FakeTelethonMessage(date=event_date))

    assert message.id == 73
    assert message.text == "promo"
    assert message.date == datetime(2026, 9, 13, 12, 30, tzinfo=UTC)


def test_naive_telegram_timestamp_is_explicitly_interpreted_as_utc() -> None:
    event_date = datetime(2026, 9, 13, 12, 30)

    assert normalize_telegram_datetime(event_date) == datetime(
        2026, 9, 13, 12, 30, tzinfo=UTC
    )


class FakeIterMessagesClient:
    """Records how `iter_messages` was called and yields `count` newest-first messages."""

    def __init__(self, count: int) -> None:
        self._count = count
        self.calls: list[tuple[object, dict[str, object]]] = []

    async def iter_messages(
        self, entity: object, **kwargs: object
    ) -> AsyncIterator[FakeTelethonMessage]:
        self.calls.append((entity, kwargs))
        base = datetime(2026, 9, 21, tzinfo=UTC)
        for index in range(self._count):
            message = FakeTelethonMessage(date=base - timedelta(minutes=index))
            message.id = self._count - index
            yield message


async def test_iter_recent_applies_no_message_ceiling() -> None:
    """S13-05: the scan reaches as far back as the caller's date cutoff asks.

    Any `limit`/`min_id` here would cap a busy group before 15 days, and Telethon
    treats an absent `limit` as the whole history (paged, with its own pacing).
    """
    client = FakeIterMessagesClient(count=5000)  # far more than any 100-message page or limit
    fetcher = TelethonMessageFetcher(client)

    ids = [message.id async for message in fetcher.iter_recent("-100123")]

    assert len(ids) == 5000
    assert client.calls == [(-100123, {})]
