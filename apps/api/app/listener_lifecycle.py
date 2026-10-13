"""What the listener does after each successful Telegram connection (S13-02).

Extracted from `scripts/run_listener.py::main` so the boot/reconnect split can
be exercised with fakes instead of only by reading a long script. Behaviour of
the moved code is unchanged; what is new is *when* each part runs now that a
dropped connection no longer restarts the process:

- first connection of the process: `_startup` — cursor preparation (S6-04),
  the live handler registration, then the non-notifying historical scan
  (S6-02/S7-04, 15 days since S13-05);
- every later connection (in-process reconnect after a drop): only `catch_up`,
  the cursor-based backfill of S5-02 bounded by `max_messages`/`max_age`. The
  15-day scan is deliberately not repeated — that repeated scan on every
  Docker restart was part of the real cost this task removes. The single
  exception is a source whose scan was cut short by a connection failure: only
  that source is scanned again on the next connection.

S13-06 adds `apply_config`: the panel's "Aplicar regras" makes the running
listener switch to the current database configuration without exiting, dropping
the MTProto connection or repeating the boot catch-up (see its docstring).

`catch_up` is serialized by a lock because two triggers exist (the supervisor's
own reconnect and the polling watchdog of `reconnect_watch.py`, which also
notices Telethon's silent internal reconnects); concurrent runs over the same
gap would race on the cursor and could notify the same message twice.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy.orm import Session, sessionmaker

from app.pipeline import (
    HISTORICAL_WINDOW,
    IncomingMessage,
    ListenerFetcherProtocol,
    ListenerSource,
    catch_up_since_cursor,
    initialize_new_source_cursor,
    prepare_source_at_startup,
    process_message,
    run_historical_scan,
)
from models import Recipient, Rule, Source
from packages.notifications.bot import BotNotifier
from packages.rules.dedupe import DedupeCache
from packages.telegram.connection_supervisor import describe_error, is_transient_connection_error
from packages.telegram.cursor import TelegramMessage
from packages.telegram.links import build_message_link

logger = logging.getLogger(__name__)

Printer = Callable[[str], None]


@dataclass(frozen=True)
class ScanSummary:
    """What one non-notifying historical scan found: new matches, and how many
    sources' scans did not finish (their config is still live)."""

    matches: int = 0
    failures: int = 0


def build_listener_sources(
    sources: Sequence[Source], rules: Sequence[Rule], recipients: Sequence[Recipient]
) -> list[ListenerSource]:
    """Turn the active configuration into what the pipeline consumes.

    No rule or no recipient means there is nothing to evaluate or deliver, so
    *no source is listened to at all* — the same "nada pra escutar" the boot
    always had. This is not cosmetic: a source that is "live" with zero rules
    would never advance its cursor (`process_message` only runs per rule), and
    the next reconnect catch-up would then read the whole gap as messages
    missed during a drop and alert retroactively (S6-04). Keeping such sources
    out of the live set means they are treated as *new* — cursor initialized at
    the chat's head, no alert — when a rule finally appears.
    """
    if not rules or not recipients:
        return []
    return [
        ListenerSource(
            source_id=source.id,
            chat_id=source.telegram_chat_id,
            rules=list(rules),
            recipients=list(recipients),
        )
        for source in sources
    ]


def _chat_index(sources: Sequence[ListenerSource]) -> dict[int, ListenerSource]:
    return {int(source.chat_id): source for source in sources}


@dataclass(frozen=True)
class ApplyOutcome:
    sources_loaded: int
    new_matches: int
    scan_failures: int


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
        historical_window: timedelta = HISTORICAL_WINDOW,
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
        # S13-06: the live handler asks this map per message; `apply_config`
        # replaces it as a whole (never edits it in place), so a message in
        # flight always sees one consistent configuration.
        self._by_chat_id = _chat_index(self._sources)
        self.started = False
        # What the boot scan found, for the panel's "N matches no histórico".
        self.boot_scan = ScanSummary()

    def source_for_chat(self, chat_id: int | None) -> ListenerSource | None:
        """The live configuration for a chat, or `None` if it is not listened to."""
        return None if chat_id is None else self._by_chat_id.get(chat_id)

    @property
    def sources(self) -> list[ListenerSource]:
        return list(self._sources)

    async def handle_live_message(self, chat_id: int | None, message: TelegramMessage) -> None:
        """What the registered Telethon handler does for one live message.

        The configuration is read once, up front: rules and recipients of a
        single message always come from the same applied configuration, even if
        a reload lands halfway through.
        """
        source = self.source_for_chat(chat_id)
        if source is None:
            return  # not a listened chat: dropped, nothing read or stored
        for rule in source.rules:
            with self._session_factory() as session:
                incoming = IncomingMessage(
                    source_id=source.source_id,
                    message_id=message.id,
                    text=message.text,
                    link=build_message_link(source.chat_id, message.id),
                    received_at=message.date,
                )
                result = await process_message(
                    session, incoming, rule, source.recipients, self._notifier, self._dedupe_cache
                )
                session.commit()
                if result.match is not None:
                    self._print(
                        f"Match! fonte_id={source.source_id} regra={rule.name} "
                        f"match_id={result.match.id} entregas={result.deliveries_sent}"
                    )

    async def on_connected(self) -> None:
        """Call after every successful connection; picks boot or reconnect work."""
        if not self.started:
            self.boot_scan = await self._startup()
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

    async def apply_config(
        self, new_sources: Sequence[ListenerSource], *, allowlisted_chat_ids: set[str]
    ) -> ApplyOutcome:
        """S13-06: switch the running listener to a new configuration, in process.

        Serialized with `catch_up` by the same lock, so a reconnect recovery
        never runs half on the old rules and half on the new ones. Order matters:

        1. A source that was not being listened to until now (new, re-activated,
           or held out because there were no rules) only gets its cursor moved
           to the chat's head — never the notifying catch-up of S6-04, which
           would alert retroactively for everything since the cursor.
        2. Only then the live configuration (handler map, recipients, the bot's
           allowlist) is swapped, in one step.
        3. A non-notifying historical scan runs against the *new* rules, with
           `before` taken after the swap: anything older is history (no alert),
           anything newer belongs to the live handler. Nothing falls between.

        Any failure in step 1 (or in building the chat map) propagates before
        anything was swapped, so the previous configuration stays live. A
        source whose *scan* fails does not undo a configuration that is already
        live: it is counted, and re-scanned on the next connection if the cause
        was a network drop. Idempotent: reapplying the same configuration
        persists nothing new (message identity, S6-01).
        """
        async with self._catch_up_lock:
            next_index = _chat_index(new_sources)  # may raise: nothing swapped yet
            currently_live = {source.source_id for source in self._sources}
            for source in new_sources:
                if source.source_id in currently_live:
                    continue
                with self._session_factory() as session:
                    await initialize_new_source_cursor(
                        session, self._fetcher, source.source_id, source.chat_id
                    )
                    session.commit()

            self._sources = list(new_sources)
            self._by_chat_id = next_index
            self._notifier.set_allowlisted_chat_ids(allowlisted_chat_ids)
            summary = await self._run_historical_scan(self._sources)
            return ApplyOutcome(
                sources_loaded=len(self._sources),
                new_matches=summary.matches,
                scan_failures=summary.failures,
            )

    async def _startup(self) -> ScanSummary:
        await self._prepare_cursors()
        if not self._handler_registered:
            self._register_live_handler()
            self._handler_registered = True
        return await self._run_historical_scan(self._historical_pending)

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

    async def _run_historical_scan(self, sources: Sequence[ListenerSource]) -> ScanSummary:
        """Non-notifying scan (S6-02). Fixed `before` *after* the live handler is
        registered, so anything arriving during the scan is the live handler's
        alert, never a duplicate "historical" one.
        """
        scan_started_at = self._now()
        matches = 0
        failures = 0
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
                failures += 1
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
        return ScanSummary(matches=matches, failures=failures)
