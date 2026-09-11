from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Protocol

from sqlalchemy import select
from sqlalchemy.orm import Session

from models import ProcessingCursor


@dataclass
class TelegramMessage:
    id: int
    text: str
    date: datetime


class MessageFetcherProtocol(Protocol):
    def iter_messages(
        self, chat_id: str, *, min_id: int, limit: int
    ) -> AsyncIterator[TelegramMessage]: ...


def get_cursor(session: Session, source_id: int) -> int:
    """Last `message_id` processed for `source_id`, or 0 if the source is new."""
    cursor = session.scalar(select(ProcessingCursor).where(ProcessingCursor.source_id == source_id))
    return cursor.last_message_id if cursor is not None else 0


def _advance_cursor(session: Session, source_id: int, message_id: int) -> ProcessingCursor:
    cursor = session.scalar(select(ProcessingCursor).where(ProcessingCursor.source_id == source_id))
    if cursor is None:
        cursor = ProcessingCursor(source_id=source_id, last_message_id=message_id)
        session.add(cursor)
    elif message_id > cursor.last_message_id:
        cursor.last_message_id = message_id
    session.flush()
    return cursor


async def backfill_since_cursor(
    session: Session,
    client: MessageFetcherProtocol,
    source_id: int,
    chat_id: str,
    *,
    max_messages: int = 100,
    max_age: timedelta | None = None,
    now: datetime | None = None,
) -> list[TelegramMessage]:
    """Fetch messages newer than the persisted cursor after a (re)connect.

    Only messages with `id` strictly greater than the cursor are returned, so
    a message already seen before a disconnect is never reprocessed — no
    duplicate alert. The result is bounded by `max_messages` and, when
    `max_age` is set, by how old the message is. The cursor advances to the
    highest `id` actually returned.
    """
    last_id = get_cursor(session, source_id)
    cutoff: datetime | None = None
    if max_age is not None:
        cutoff = (now or datetime.now(UTC)) - max_age

    collected: list[TelegramMessage] = []
    async for message in client.iter_messages(chat_id, min_id=last_id, limit=max_messages):
        if message.id <= last_id:
            continue
        if cutoff is not None and message.date < cutoff:
            continue
        collected.append(message)
        if len(collected) >= max_messages:
            break

    if collected:
        newest_id = max(message.id for message in collected)
        _advance_cursor(session, source_id, newest_id)

    return collected
