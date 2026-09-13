from __future__ import annotations

from collections.abc import AsyncIterator
from datetime import datetime, timedelta
from typing import Protocol

from packages.telegram.cursor import TelegramMessage


class RecentMessageFetcherProtocol(Protocol):
    def iter_recent(self, chat_id: str) -> AsyncIterator[TelegramMessage]: ...


async def fetch_messages_since(
    fetcher: RecentMessageFetcherProtocol,
    chat_id: str,
    *,
    window: timedelta,
    before: datetime,
) -> list[TelegramMessage]:
    """Fetch every message in `chat_id` with `before - window < date < before`.

    Deliberately independent of `packages.telegram.cursor` (S6-02's homologation
    scan must never read or advance the per-source `ProcessingCursor` used by
    the live/reconnect path) and unbounded in *count* — only `window` limits
    what qualifies, never a fixed message cap. Iterates newest-to-oldest (the
    real Telegram API's own default order) and stops as soon as a message
    falls at or before the cutoff, so a long-lived group is never paged
    through further than the window actually requires.

    `before` is the caller's job to fix, not `datetime.now()` taken internally
    here: the listener captures it once, right after the live handler is
    already registered, so a message that arrives while this scan is still
    running always has `date >= before` and is skipped here — it is the live
    handler's alert to send, never a duplicate "historical" one from a scan
    that happened to still be paging through results when it arrived.
    """
    cutoff = before - window
    collected: list[TelegramMessage] = []
    async for message in fetcher.iter_recent(chat_id):
        if message.date >= before:
            continue
        if message.date <= cutoff:
            break
        collected.append(message)
    return collected
