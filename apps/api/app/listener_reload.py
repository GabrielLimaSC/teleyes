"""Listener side of the "Aplicar regras" button (S13-06).

A short polling loop (a few seconds) inside the listener process: it keeps a
heartbeat for the panel, and when the panel has left a `pending` request it
claims it, reloads the configuration through `ListenerLifecycle.apply_config`
and writes the outcome back. Polling the database (rather than being told over
a socket) is the whole point: `api` and `listener` share nothing but the file.

A request is only claimed while the listener is really able to apply it — its
boot finished and the Telegram connection is up. Otherwise it simply stays
`pending` and is picked up the moment the connection returns.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from datetime import UTC, datetime

from sqlalchemy.orm import Session, sessionmaker

from app.listener_control import (
    claim_reload,
    config_fingerprint,
    load_active_config,
    record_applied,
    record_failed,
    touch_listener_seen,
)
from app.listener_lifecycle import ListenerLifecycle, build_listener_sources

logger = logging.getLogger(__name__)

POLL_SECONDS = 3.0


class ReloadWorker:
    def __init__(
        self,
        *,
        session_factory: sessionmaker[Session],
        lifecycle: ListenerLifecycle,
        is_connected: Callable[[], bool],
        now: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self._session_factory = session_factory
        self._lifecycle = lifecycle
        self._is_connected = is_connected
        self._now = now

    async def poll_once(self) -> bool:
        """One tick. Returns whether a reload request was applied or failed."""
        with self._session_factory() as session:
            touch_listener_seen(session, now=self._now())
            if not (self._lifecycle.started and self._is_connected()):
                return False
            if not claim_reload(session, now=self._now()):
                return False
        await self._apply()
        return True

    async def _apply(self) -> None:
        try:
            with self._session_factory() as session:
                sources, rules, recipients = load_active_config(session)
            outcome = await self._lifecycle.apply_config(
                build_listener_sources(sources, rules, recipients),
                allowlisted_chat_ids={recipient.telegram_chat_id for recipient in recipients},
            )
        except Exception as error:
            # Class name only: an exception message can quote message text.
            error_class = type(error).__name__
            logger.error("event=reload_failed error_class=%s", error_class)
            self._record(lambda session: record_failed(session, error_class=error_class))
            return

        fingerprint = config_fingerprint(sources, rules, recipients)
        logger.info(
            "event=reload_applied sources=%d rules=%d recipients=%d new_matches=%d",
            len(sources),
            len(rules),
            len(recipients),
            outcome.new_matches,
        )
        self._record(
            lambda session: record_applied(
                session,
                sources_loaded=len(sources),
                rules_loaded=len(rules),
                recipients_loaded=len(recipients),
                config_hash=fingerprint,
                new_matches=outcome.new_matches,
                scan_failures=outcome.scan_failures,
                now=self._now(),
            )
        )

    def _record(self, write: Callable[[Session], None]) -> None:
        """The outcome write must not take the loop down (e.g. a locked file)."""
        try:
            with self._session_factory() as session:
                write(session)
        except Exception as error:
            logger.error("event=reload_status_write_failed error_class=%s", type(error).__name__)

    async def run(self, stop_event: asyncio.Event, poll_seconds: float = POLL_SECONDS) -> None:
        while not stop_event.is_set():
            try:
                await self.poll_once()
            except Exception as error:
                logger.error("event=reload_poll_failed error_class=%s", type(error).__name__)
            try:
                await asyncio.wait_for(stop_event.wait(), timeout=poll_seconds)
            except TimeoutError:
                pass
