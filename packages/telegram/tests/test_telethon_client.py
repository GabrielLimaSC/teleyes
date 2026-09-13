from datetime import UTC, datetime, timedelta, timezone

from packages.telegram.telethon_client import normalize_telegram_datetime, to_telegram_message


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
