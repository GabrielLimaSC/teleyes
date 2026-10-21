"""S19-03: background work the api does itself in demo mode.

There is no listener process in the demo stack, so the api keeps the listener
heartbeat fresh (Saúde would otherwise report it offline after 90 s) and, with
`TELEYES_DEMO_LIVE=1`, inserts one fictional match every 20-40 s so the live feed
visibly moves. Both loops are cancelled on shutdown.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager

from sqlalchemy.orm import Session, sessionmaker

from app.demo_seed import DemoReplayer
from app.listener_control import ensure_control_row, touch_listener_seen

logger = logging.getLogger(__name__)

HEARTBEAT_SECONDS = 25.0

Sleep = Callable[[float], Awaitable[None]]


async def run_heartbeat(
    session_factory: sessionmaker[Session], *, sleep: Sleep = asyncio.sleep
) -> None:
    while True:
        try:
            with session_factory() as session:
                ensure_control_row(session)
                touch_listener_seen(session)
        except Exception as error:  # a locked database must not end the loop
            logger.warning("event=demo_heartbeat_failed error_class=%s", type(error).__name__)
        await sleep(HEARTBEAT_SECONDS)


async def run_replayer(replayer: DemoReplayer, *, sleep: Sleep = asyncio.sleep) -> None:
    while True:
        await sleep(replayer.next_delay_seconds())
        try:
            await replayer.tick()
        except Exception as error:
            logger.warning("event=demo_replay_failed error_class=%s", type(error).__name__)


@asynccontextmanager
async def demo_background(
    session_factory: sessionmaker[Session], *, live: bool
) -> AsyncIterator[None]:
    tasks = [asyncio.create_task(run_heartbeat(session_factory))]
    if live:
        tasks.append(asyncio.create_task(run_replayer(DemoReplayer(session_factory))))
    try:
        yield
    finally:
        for task in tasks:
            task.cancel()
        for task in tasks:
            with contextlib.suppress(asyncio.CancelledError):
                await task
