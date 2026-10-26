"""Retry helper for SQLite "database is locked" errors (S13-04).

SQLite has a single writer. `busy_timeout` already makes a blocked writer wait,
but when the wait still runs out (another process holding the lock for long, a
checkpoint, a backup) the write raises `OperationalError`. For the listener
that used to mean a lost live message, so its critical writes retry a few times
with a short, growing, async pause (the event loop keeps serving other tasks
while we wait) before giving up.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable

from sqlalchemy.exc import OperationalError

logger = logging.getLogger(__name__)

DEFAULT_ATTEMPTS = 6
DEFAULT_BASE_DELAY = 0.25
MAX_DELAY = 2.0


def is_locked_error(error: BaseException) -> bool:
    """Whether `error` is SQLite's transient busy/locked condition."""
    if not isinstance(error, OperationalError):
        return False
    message = str(error.orig if error.orig is not None else error).lower()
    return "database is locked" in message or "database table is locked" in message


async def retry_when_locked[T](
    operation: Callable[[], T],
    *,
    on_retry: Callable[[], None] | None = None,
    attempts: int | None = None,
    base_delay: float | None = None,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
) -> T:
    """Run `operation`, retrying only on a locked-database error.

    `on_retry` runs before each retry (typically `session.rollback`). Any other
    exception propagates immediately; after the last attempt the lock error does
    too. Logs the class and attempt only, never message content.
    """
    # Resolved per call (not as defaults) so tests can shrink the module constants.
    max_attempts = DEFAULT_ATTEMPTS if attempts is None else attempts
    delay = DEFAULT_BASE_DELAY if base_delay is None else base_delay
    attempt = 0
    while True:
        attempt += 1
        try:
            return operation()
        except OperationalError as error:
            if not is_locked_error(error) or attempt >= max_attempts:
                raise
            logger.warning("event=db_locked_retry attempt=%d of=%d", attempt, max_attempts)
            if on_retry is not None:
                on_retry()
            await sleep(min(delay * 2 ** (attempt - 1), MAX_DELAY))


async def retry_when_locked_async[T](
    operation: Callable[[], Awaitable[T]],
    *,
    attempts: int | None = None,
    base_delay: float | None = None,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
) -> T:
    """`retry_when_locked` for a coroutine operation that owns its own cleanup."""
    # Resolved per call (not as defaults) so tests can shrink the module constants.
    max_attempts = DEFAULT_ATTEMPTS if attempts is None else attempts
    delay = DEFAULT_BASE_DELAY if base_delay is None else base_delay
    attempt = 0
    while True:
        attempt += 1
        try:
            return await operation()
        except OperationalError as error:
            if not is_locked_error(error) or attempt >= max_attempts:
                raise
            logger.warning("event=db_locked_retry attempt=%d of=%d", attempt, max_attempts)
            await sleep(min(delay * 2 ** (attempt - 1), MAX_DELAY))
