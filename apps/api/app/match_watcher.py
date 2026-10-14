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
- A new match with no delivery yet is held for a grace period (see `MatchWatcher`).
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
import time
from collections import OrderedDict
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
# How long a new match with no delivery row is held, waiting for the listener to
# record the outcome, before being published as a match without recipients.
GRACE_SECONDS = 8.0
MAX_PENDING = 500
MAX_TRACKED = 500
BATCH_LIMIT = 200


def read_max_match_id(session: Session) -> int:
    return session.scalar(select(func.max(Match.id))) or 0


Signature = tuple[tuple[int, str, str | None], ...]


def _signature(deliveries: list[Delivery]) -> Signature:
    """What the card shows about deliveries: identity, status and delivery time.

    A new row changes it (late delivery), and so does an update in place such as
    a `failed` delivery later becoming `sent` (same id, new status/delivered_at).
    """
    return tuple(
        sorted(
            (d.id, d.status, d.delivered_at.isoformat() if d.delivered_at else None)
            for d in deliveries
        )
    )


def _is_historical_only(deliveries: list[Delivery]) -> bool:
    return bool(deliveries) and all(d.status == HISTORICAL_DELIVERY_STATUS for d in deliveries)


def _load_deliveries(session: Session, match_ids: list[int]) -> dict[int, list[Delivery]]:
    grouped: dict[int, list[Delivery]] = {match_id: [] for match_id in match_ids}
    if match_ids:
        for delivery in session.scalars(select(Delivery).where(Delivery.match_id.in_(match_ids))):
            grouped[delivery.match_id].append(delivery)
    return grouped


def _event_for(session: Session, match: Match, deliveries: list[Delivery]) -> dict[str, Any] | None:
    result = ProcessResult(
        match=match,
        deliveries_sent=sum(1 for d in deliveries if d.status == "sent"),
        target_hit=any(d.kind == DELIVERY_KIND_TARGET and d.status == "sent" for d in deliveries),
    )
    return build_match_event(result, session)


class MatchWatcher:
    """Polls the shared database and publishes `match` events.

    Race handled here: the listener commits the match BEFORE calling the bot and
    writes the `Delivery` rows afterwards (S13-04). Publishing at once would make
    the frontend reload a card with no deliveries ("Sem destinatário"). So a new
    match without deliveries is held in `_pending` until a delivery shows up, or
    until `GRACE_SECONDS` pass (a rule with genuinely no recipient), then it is
    published anyway. Once published, a match is tracked by its deliveries'
    signature and re-published (one event per tick) when it changes, which
    refreshes the card for late deliveries and in-place status updates
    (failed -> sent). Everything is in memory and read-only.
    """

    def __init__(
        self,
        session_factory: Callable[[], Session],
        broker: EventBroker,
        interval: float = POLL_INTERVAL_SECONDS,
        grace_seconds: float = GRACE_SECONDS,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._session_factory = session_factory
        self._broker = broker
        self._interval = interval
        self._grace = grace_seconds
        self._clock = clock
        self._last_seen_id: int | None = None
        self._pending: dict[int, float] = {}
        self._published: OrderedDict[int, Signature] = OrderedDict()

    def _remember(self, match_id: int, signature: Signature) -> None:
        self._published[match_id] = signature
        self._published.move_to_end(match_id)
        while len(self._published) > MAX_TRACKED:
            self._published.popitem(last=False)

    def _poll_sync(self) -> list[dict[str, Any]]:
        with self._session_factory() as session:
            if self._last_seen_id is None:
                self._last_seen_id = read_max_match_id(session)
                return []
            now = self._clock()
            events: list[dict[str, Any]] = []

            new_ids = list(
                session.scalars(
                    select(Match.id)
                    .where(Match.id > self._last_seen_id)
                    .order_by(Match.id)
                    .limit(BATCH_LIMIT)
                )
            )
            if new_ids:
                self._last_seen_id = new_ids[-1]
                for match_id in new_ids:
                    self._pending[match_id] = now
                while len(self._pending) > MAX_PENDING:
                    # Over the cap: stop holding the oldest instead of growing.
                    self._pending[next(iter(self._pending))] = float("-inf")

            watched = list(self._pending) + list(self._published)
            deliveries = _load_deliveries(session, watched)
            matches = {m.id: m for m in session.scalars(select(Match).where(Match.id.in_(watched)))}

            for match_id in list(self._pending):
                rows = deliveries[match_id]
                if _is_historical_only(rows):
                    del self._pending[match_id]
                    continue
                if not rows and now - self._pending[match_id] < self._grace:
                    continue
                del self._pending[match_id]
                event = (
                    _event_for(session, matches[match_id], rows) if match_id in matches else None
                )
                if event is not None:
                    events.append(event)
                    self._remember(match_id, _signature(rows))

            for match_id, known in list(self._published.items()):
                if match_id not in matches or any(e["match_id"] == match_id for e in events):
                    continue
                rows = deliveries[match_id]
                signature = _signature(rows)
                if signature == known or _is_historical_only(rows):
                    continue
                event = _event_for(session, matches[match_id], rows)
                if event is not None:
                    events.append(event)
                    self._remember(match_id, signature)
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
    grace_seconds: float = GRACE_SECONDS,
) -> AsyncIterator[MatchWatcher]:
    watcher = MatchWatcher(session_factory, broker, interval, grace_seconds)
    task = asyncio.create_task(watcher.run())
    try:
        yield watcher
    finally:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task
