"""S17-03: turn matches written by the listener process into live SSE events.

The `EventBroker` lives in memory inside the `api` process, while matches are
created by the listener, which runs in another container. The two share only
the SQLite file, so the `api` watches the `match` table: every few seconds it
reads rows with an id greater than the last one it has seen and publishes a
`match` event for each. No new infrastructure, read-only access.

Design notes:
- The cursor starts at the current MAX(match.id) at boot, so history is never
  re-emitted after a restart. SSE reconnects (Last-Event-ID) replay only what
  the broker still holds, never this module's output twice, because each id is
  published at most once per process.
- Matches created by the non-notifying historical scan (every delivery has
  status "historical") are NOT published: they are old messages, not news, and
  must not jump to the top of the feed as if they were new. They show up on the
  next manual or regular load. The cursor still moves past them.
- The frontend reloads `GET /matches` on each `match` event, so folding into an
  existing duplicate group (S14-05) and the active rule filter are handled by
  that read; the payload also carries `group_key`/`grouped_summary`.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

from app.db_retry import is_locked_error
from app.pipeline import (
    DELIVERY_KIND_TARGET,
    HISTORICAL_DELIVERY_STATUS,
    ProcessResult,
    build_match_event,
)
from models import Delivery, Match
from packages.events.broker import EventBroker

logger = logging.getLogger(__name__)

POLL_INTERVAL_SECONDS = 2.0
BATCH_LIMIT = 200


def read_max_match_id(session: Session) -> int:
    return session.scalar(select(func.max(Match.id))) or 0


def collect_new_match_events(
    session: Session, last_seen_id: int
) -> tuple[list[dict[str, Any]], int]:
    """Read matches newer than `last_seen_id`; return their events and the new cursor.

    Read-only. Historical-scan matches are skipped (see module docstring) but
    still advance the cursor.
    """
    matches = list(
        session.scalars(
            select(Match).where(Match.id > last_seen_id).order_by(Match.id).limit(BATCH_LIMIT)
        )
    )
    events: list[dict[str, Any]] = []
    cursor = last_seen_id
    for match in matches:
        cursor = match.id
        deliveries = list(session.scalars(select(Delivery).where(Delivery.match_id == match.id)))
        if deliveries and all(d.status == HISTORICAL_DELIVERY_STATUS for d in deliveries):
            continue
        result = ProcessResult(
            match=match,
            deliveries_sent=sum(1 for d in deliveries if d.status == "sent"),
            target_hit=any(
                d.kind == DELIVERY_KIND_TARGET and d.status == "sent" for d in deliveries
            ),
        )
        event = build_match_event(result, session)
        if event is not None:
            events.append(event)
    return events, cursor


class MatchWatcher:
    def __init__(
        self,
        session_factory: Callable[[], Session],
        broker: EventBroker,
        interval: float = POLL_INTERVAL_SECONDS,
    ) -> None:
        self._session_factory = session_factory
        self._broker = broker
        self._interval = interval
        self._last_seen_id: int | None = None

    def _poll_sync(self) -> list[dict[str, Any]]:
        with self._session_factory() as session:
            if self._last_seen_id is None:
                self._last_seen_id = read_max_match_id(session)
                return []
            events, self._last_seen_id = collect_new_match_events(session, self._last_seen_id)
            return events

    async def poll_once(self) -> int:
        """One tick: read in a worker thread, publish on the event loop. Returns the count."""
        events = await asyncio.to_thread(self._poll_sync)
        for event in events:
            self._broker.publish("match", event)
        return len(events)

    async def run(self) -> None:
        while True:
            try:
                await self.poll_once()
            except asyncio.CancelledError:
                raise
            except OperationalError as error:
                # Locked: the cursor was not advanced, so the next tick retries.
                if is_locked_error(error):
                    logger.warning("event=match_watcher_db_locked")
                else:
                    logger.exception("event=match_watcher_failed")
            except Exception:
                logger.exception("event=match_watcher_failed")
            await asyncio.sleep(self._interval)


@asynccontextmanager
async def watch_matches(
    session_factory: Callable[[], Session],
    broker: EventBroker,
    interval: float = POLL_INTERVAL_SECONDS,
) -> AsyncIterator[MatchWatcher]:
    watcher = MatchWatcher(session_factory, broker, interval)
    task = asyncio.create_task(watcher.run())
    try:
        yield watcher
    finally:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task
