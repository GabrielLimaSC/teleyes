from __future__ import annotations

from collections.abc import AsyncIterator
from datetime import UTC, datetime
from typing import Protocol

from packages.telegram.cursor import TelegramMessage


class IterMessagesClientProtocol(Protocol):
    def iter_messages(
        self, entity: object, *, min_id: int = 0, limit: int | None = None
    ) -> AsyncIterator[TelegramMessageLike]: ...


class TelegramMessageLike(Protocol):
    id: int
    text: str | None
    date: datetime


def normalize_telegram_datetime(value: datetime) -> datetime:
    """Return a Telegram event timestamp as an aware UTC datetime."""
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def to_telegram_message(message: TelegramMessageLike) -> TelegramMessage:
    """Copy identity, content and the real event time from a Telethon message."""
    return TelegramMessage(
        id=message.id,
        text=message.text or "",
        date=normalize_telegram_datetime(message.date),
    )


class TelethonMessageFetcher:
    """Adapts a real `telethon.TelegramClient` to `cursor.MessageFetcherProtocol`.

    `backfill_since_cursor` (packages/telegram/cursor.py) is Telethon-agnostic
    on purpose — this is the one place that actually calls into the real
    library, translating its `Message` objects into the plain `TelegramMessage`
    dataclass the rest of the pipeline already knows how to handle, same as
    `packages/notifications/http_client.py::HttpBotClient` does for the bot
    side of things.
    """

    def __init__(self, client: IterMessagesClientProtocol) -> None:
        self._client = client

    async def iter_messages(
        self, chat_id: str, *, min_id: int, limit: int
    ) -> AsyncIterator[TelegramMessage]:
        async for message in self._client.iter_messages(int(chat_id), min_id=min_id, limit=limit):
            yield to_telegram_message(message)

    async def iter_recent(self, chat_id: str) -> AsyncIterator[TelegramMessage]:
        """Adapts to `packages.telegram.historical.RecentMessageFetcherProtocol`.

        No `min_id`/`limit` here on purpose (S6-02): a homologation scan is
        independent of the per-source cursor, and must not stop early on a
        fixed count — only `fetch_messages_since`'s time window (7 days by
        default, S7-04) decides when to stop consuming this newest-to-oldest
        iterator.
        """
        async for message in self._client.iter_messages(int(chat_id)):
            yield to_telegram_message(message)
