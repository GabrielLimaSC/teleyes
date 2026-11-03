"""S21-09: once a minute, remember how the services looked.

The panel's Saúde screen draws 24 hourly bars per service. `/health` only knows the
present, so the api samples it: each minute it asks the same questions `/health` and
`/listener/status` answer, and adds one sample (healthy or not) to that service's
current-hour row in `service_heartbeat`.

Rules this module keeps:
- Nothing blocks the event loop: the whole sample (reads and the short write) runs in a
  worker thread, and no transaction is open while the loop sleeps.
- A service that is not configured (or is a demo stub) gets *no sample at all*: "off on
  purpose" must never read as "down", nor as "up". The history stays empty for it.
- It also runs the daily 30-day retention for the three S21-09 tables.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta

from fastapi import FastAPI
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.listener_control import read_snapshot
from app.routers.health import bot_health, telegram_health
from packages.metrics.hourly import ServiceName, purge_old, record_heartbeat_sample
from packages.telegram.adapter import AdapterState

logger = logging.getLogger(__name__)

SAMPLE_INTERVAL_SECONDS = 60.0
PURGE_INTERVAL = timedelta(hours=24)

Sleep = Callable[[float], Awaitable[None]]


def _database_ok(session: Session) -> bool:
    try:
        session.execute(text("SELECT 1"))
    except Exception:
        return False
    return True


def _listener_online(session: Session) -> bool:
    try:
        return read_snapshot(session).listener_online
    except Exception:
        return False


class HealthSampler:
    def __init__(
        self,
        app: FastAPI,
        *,
        interval: float = SAMPLE_INTERVAL_SECONDS,
        now: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self._app = app
        self._interval = interval
        self._now = now
        self._last_purge: datetime | None = None

    def collect(self, session: Session) -> dict[ServiceName, bool | None]:
        """`True`/`False` per service, `None` for "do not sample" (not configured, demo)."""
        listener_online = _listener_online(session)
        states: dict[ServiceName, bool | None] = {}

        telegram = telegram_health(self._app)
        if telegram.state == AdapterState.DEMO or not telegram.configured:
            states[ServiceName.TELEGRAM] = None
        else:
            # The listener owns the one MTProto connection; the api's own adapter never
            # connects, so a fresh listener heartbeat is what proves the session is alive.
            states[ServiceName.TELEGRAM] = (
                telegram.state == AdapterState.CONNECTED or listener_online
            )

        bot = bot_health(self._app)
        states[ServiceName.BOT] = True if bot.state == "configured" else None

        states[ServiceName.LISTENER] = listener_online
        states[ServiceName.SSE] = self._sse_ok()
        states[ServiceName.DB] = _database_ok(session)
        return states

    def _sse_ok(self) -> bool:
        watcher = getattr(self._app.state, "match_watcher", None)
        return True if watcher is None else bool(watcher.is_healthy())

    def sample_once(self) -> None:
        """One synchronous sample in its own short transaction (call from a thread)."""
        moment = self._now()
        with self._app.state.session_factory() as session:
            for service, healthy in self.collect(session).items():
                if healthy is not None:
                    record_heartbeat_sample(session, service.value, healthy, now=moment)
            if self._last_purge is None or moment - self._last_purge >= PURGE_INTERVAL:
                purge_old(session, now=moment)  # commits the samples above too
                self._last_purge = moment
            else:
                session.commit()

    async def run(self, sleep: Sleep = asyncio.sleep) -> None:
        while True:
            try:
                # Everything touching SQLite happens in the thread; nothing is held open
                # across the await below.
                await asyncio.to_thread(self.sample_once)
            except asyncio.CancelledError:
                raise
            except Exception as error:  # a locked database must not end the loop
                logger.warning("event=health_sample_failed error_class=%s", type(error).__name__)
            await sleep(self._interval)


@asynccontextmanager
async def sample_health(
    app: FastAPI, *, interval: float = SAMPLE_INTERVAL_SECONDS
) -> AsyncIterator[HealthSampler]:
    sampler = HealthSampler(app, interval=interval)
    task = asyncio.create_task(sampler.run())
    try:
        yield sampler
    finally:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task
