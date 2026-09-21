"""What the listener does after each successful Telegram connection (S13-02).

Extracted from `scripts/run_listener.py::main` so the boot/reconnect split can
be exercised with fakes instead of only by reading a long script. Behaviour of
the moved code is unchanged; what is new is *when* each part runs now that a
dropped connection no longer restarts the process:

- first connection of the process: `_startup` — cursor preparation (S6-04),
  the live handler registration, then the non-notifying historical scan
  (S6-02/S7-04, 7 days);
- every later connection (in-process reconnect after a drop): only `catch_up`,
  the cursor-based backfill of S5-02 bounded by `max_messages`/`max_age`. The
  7-day scan is deliberately not repeated — that repeated scan on every
  Docker restart was part of the real cost this task removes. The single
  exception is a source whose scan was cut short by a connection failure: only
  that source is scanned again on the next connection.

`catch_up` is serialized by a lock because two triggers exist (the supervisor's
own reconnect and the polling watchdog of `reconnect_watch.py`, which also
notices Telethon's silent internal reconnects); concurrent runs over the same
gap would race on the cursor and could notify the same message twice.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable, Sequence
from datetime import UTC, datetime, timedelta

from sqlalchemy.orm import Session, sessionmaker

from app.pipeline import (
    ListenerFetcherProtocol,
    ListenerSource,
    catch_up_since_cursor,
    prepare_source_at_startup,
    run_historical_scan,
)
from packages.notifications.bot import BotNotifier
from packages.rules.dedupe import DedupeCache
from packages.telegram.connection_supervisor import describe_error, is_transient_connection_error

logger = logging.getLogger(__name__)

Printer = Callable[[str], None]


class ListenerLifecycle:
    def __init__(
        self,
        *,
        session_factory: sessionmaker[Session],
        fetcher: ListenerFetcherProtocol,
        sources: Sequence[ListenerSource],
        notifier: BotNotifier,
        dedupe_cache: DedupeCache,
        register_live_handler: Callable[[], None],
        backfill_max_messages: int = 100,
        backfill_max_age: timedelta = timedelta(hours=24),
        historical_window: timedelta = timedelta(days=7),
        now: Callable[[], datetime] = lambda: datetime.now(UTC),
        printer: Printer = print,
    ) -> None:
        self._session_factory = session_factory
        self._fetcher = fetcher
        self._sources = list(sources)
        self._notifier = notifier
        self._dedupe_cache = dedupe_cache
        self._register_live_handler = register_live_handler
        self._backfill_max_messages = backfill_max_messages
        self._backfill_max_age = backfill_max_age
        self._historical_window = historical_window
        self._now = now
        self._print = printer
        self._catch_up_lock = asyncio.Lock()
        self._historical_pending = list(self._sources)
        self._handler_registered = False
        self.started = False

    async def on_connected(self) -> None:
        """Call after every successful connection; picks boot or reconnect work."""
        if not self.started:
            await self._startup()
            self.started = True
            return
        try:
            await self.catch_up()
        except Exception as error:
            if is_transient_connection_error(error):
                raise  # the supervisor backs off and reconnects
            # A non-network failure while catching up must not take down a
            # listener that is otherwise receiving live messages: say so, keep
            # listening; the next reconnect catches up again.
            logger.error("event=catch_up_failed %s", describe_error(error))
        if self._historical_pending:
            await self._run_historical_scan(self._historical_pending)

    async def catch_up(self) -> None:
        """Real reconnect recovery: notifying, cursor-based, bounded (S5-02).

        Only valid once `_startup` has run, when every source has a persisted
        cursor — otherwise it would treat a brand-new source's whole recent
        history as "missed during a drop" and alert retroactively (S6-04).
        """
        async with self._catch_up_lock:
            total = 0
            for source in self._sources:
                recovered = await catch_up_since_cursor(
                    self._session_factory,
                    self._fetcher,
                    source,
                    self._notifier,
                    self._dedupe_cache,
                    max_messages=self._backfill_max_messages,
                    max_age=self._backfill_max_age,
                )
                total += len(recovered)
            if total:
                self._print(f"Recuperadas {total} avaliações de mensagens perdidas.")

    async def _startup(self) -> None:
        await self._prepare_cursors()
        if not self._handler_registered:
            self._register_live_handler()
            self._handler_registered = True
        await self._run_historical_scan(self._historical_pending)

    async def _prepare_cursors(self) -> None:
        """Once per source, at process boot only (S6-04): a new source only gets
        its cursor initialized (no notification); a source already live-processed
        before gets the same notifying recovery a reconnect does.
        """
        recovered_total = 0
        initialized_source_ids: list[int] = []
        for source in self._sources:
            outcome = await prepare_source_at_startup(
                self._session_factory,
                self._fetcher,
                source,
                self._notifier,
                self._dedupe_cache,
                max_messages=self._backfill_max_messages,
                max_age=self._backfill_max_age,
            )
            if outcome.initialized:
                initialized_source_ids.append(source.source_id)
            else:
                recovered_total += len(outcome.recovered)

        if recovered_total:
            self._print(f"Recuperadas {recovered_total} avaliações de mensagens perdidas.")
        if initialized_source_ids:
            self._print(
                f"Fonte(s) nova(s) id={initialized_source_ids}: cursor inicializado sem "
                "catch-up notificante — histórico recente vem só do scan não notificante."
            )

    async def _run_historical_scan(self, sources: Sequence[ListenerSource]) -> None:
        """Non-notifying scan (S6-02). Fixed `before` *after* the live handler is
        registered, so anything arriving during the scan is the live handler's
        alert, never a duplicate "historical" one.
        """
        scan_started_at = self._now()
        matches = 0
        still_pending: list[ListenerSource] = []
        for source in sources:
            try:
                results = await run_historical_scan(
                    self._session_factory,
                    self._fetcher,
                    source,
                    window=self._historical_window,
                    before=scan_started_at,
                )
            except Exception as error:
                # Sanitized on purpose: never the source's chat_id/name or any
                # message content, only its internal database id — one source's
                # scan breaking must not sink the others', and must never leak
                # rejected content into a log.
                if is_transient_connection_error(error):
                    still_pending.append(source)
                    self._print(
                        f"Scan histórico interrompido para a fonte id={source.source_id} "
                        f"({describe_error(error)}); refeito na próxima conexão."
                    )
                else:
                    self._print(f"Scan histórico falhou para a fonte id={source.source_id}.")
                continue
            matches += sum(1 for result in results if result.match is not None)
        self._historical_pending = still_pending
        if matches:
            self._print(
                f"Histórico dos últimos {self._historical_window.days} dias: {matches} "
                "match(es) sem alerta retroativo."
            )
