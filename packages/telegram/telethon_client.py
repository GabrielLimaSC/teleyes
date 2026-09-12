from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Protocol

from packages.telegram.cursor import TelegramMessage


class IterMessagesClientProtocol(Protocol):
    def iter_messages(
        self, entity: object, *, min_id: int, limit: int
    ) -> AsyncIterator[object]: ...


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
            yield TelegramMessage(
                id=message.id,  # type: ignore[attr-defined]
                text=message.text or "",  # type: ignore[attr-defined]
                date=message.date,  # type: ignore[attr-defined]
            )
