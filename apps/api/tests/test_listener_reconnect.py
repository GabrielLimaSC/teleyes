"""S13-02, integration: the listener survives a refused/dropped Telegram
connection *inside the process* and recovers the gap by cursor.

Real parts: `ConnectionSupervisor`, `TelegramAdapter`, `ListenerLifecycle`, the
real pipeline (`process_message`, `catch_up_since_cursor`,
`prepare_source_at_startup`, `run_historical_scan`), a real SQLite database.
Fake parts: the Telegram client (`FlakyTelegram`, scripted refusals/drops and a
message backlog) and the bot API (`FakeBotClient`). This proves logic and
idempotence; it says nothing about the real Telegram service or a machine that
really sleeps and wakes.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from app.listener_lifecycle import ListenerLifecycle
from app.pipeline import IncomingMessage, ListenerSource, process_message
from models import Delivery, Match, Recipient, Rule, Source
from models.db import get_engine, get_sessionmaker
from packages.notifications.bot import BotNotifier
from packages.notifications.fakes import FakeBotClient
from packages.rules.dedupe import DedupeCache
from packages.telegram.adapter import TelegramAdapter
from packages.telegram.connection_supervisor import (
    BackoffPolicy,
    ConnectionSupervisor,
    SupervisorOutcome,
)
from packages.telegram.cursor import TelegramMessage, advance_cursor, get_cursor
from packages.telegram.fakes import FakeTelegramClient


def _refused() -> ConnectionRefusedError:
    return ConnectionRefusedError(111, "Connect call failed ('149.154.175.51', 443)")


class FlakyTelegram(FakeTelegramClient):
    """`FakeTelegramClient` plus what the supervisor needs from a Telethon client:
    `run_until_disconnected()` that a test can end with the exact error the
    production log shows (`ConnectionError: Connection to Telegram failed 5
    time(s)`).
    """

    def __init__(self, **kwargs: object) -> None:
        super().__init__(**kwargs)  # type: ignore[arg-type]
        self.serving = 0
        self._disconnected: asyncio.Future[None] | None = None

    async def connect(self) -> None:
        await super().connect()
        self._disconnected = asyncio.get_running_loop().create_future()

    async def run_until_disconnected(self) -> None:
        assert self._disconnected is not None
        self.serving += 1
        await asyncio.shield(self._disconnected)

    def refuse_next(self, times: int) -> None:
        self._script.extend(_refused() for _ in range(times))

    def drop(self) -> None:
        assert self._disconnected is not None
        self._disconnected.set_exception(ConnectionError("Connection to Telegram failed 5 time(s)"))


class Rig:
    """Everything `scripts/run_listener.py` wires, minus Telethon and the process."""

    def __init__(
        self,
        session: Session,
        db_path: Path,
        telegram: FlakyTelegram,
        *,
        policy: BackoffPolicy,
    ) -> None:
        self.session = session
        self.telegram = telegram
        self.session_factory: sessionmaker[Session] = get_sessionmaker(
            get_engine(f"sqlite:///{db_path}")
        )
        self.source = Source(name="Grupo Teste", telegram_chat_id="-100123")
        self.rule = Rule(name="iPhone", include_terms="iphone")
        self.recipient = Recipient(name="Gabriel", telegram_chat_id="999", allowlisted=True)
        session.add_all([self.source, self.rule, self.recipient])
        session.commit()
        self.bot = FakeBotClient()
        self.notifier = BotNotifier(
            bot_token="token", client=self.bot, allowlisted_chat_ids={"999"}
        )
        self.dedupe_cache = DedupeCache()
        self.handler_registrations = 0
        self.stop_event = asyncio.Event()
        self.sleeps: list[float] = []
        self.listener_source = ListenerSource(
            source_id=self.source.id,
            chat_id="-100123",
            rules=[self.rule],
            recipients=[self.recipient],
        )
        self.lifecycle = ListenerLifecycle(
            session_factory=self.session_factory,
            fetcher=telegram,
            sources=[self.listener_source],
            notifier=self.notifier,
            dedupe_cache=self.dedupe_cache,
            register_live_handler=self._register_handler,
            printer=lambda _message: None,
        )
        adapter = TelegramAdapter(api_id=1, api_hash="hash", client=telegram, sleep=self._sleep)
        self.supervisor = ConnectionSupervisor(
            adapter,
            wait_until_disconnected=telegram.run_until_disconnected,
            on_connected=self.lifecycle.on_connected,
            stop_event=self.stop_event,
            policy=policy,
            sleep=self._sleep,
        )

    def _register_handler(self) -> None:
        self.handler_registrations += 1

    async def _sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        await asyncio.sleep(0)  # yield, don't actually wait

    def start(self) -> asyncio.Task[SupervisorOutcome]:
        return asyncio.create_task(self.supervisor.run())

    async def wait_until_serving(self, times: int) -> None:
        async def _poll() -> None:
            while self.telegram.serving < times:
                await asyncio.sleep(0.01)

        await asyncio.wait_for(_poll(), 5)

    async def live_message(self, message_id: int, text: str) -> None:
        """What the registered Telethon handler does for a live message."""
        self.telegram.messages.append(_msg(message_id, text))
        with self.session_factory() as live_session:
            await process_message(
                live_session,
                IncomingMessage(
                    source_id=self.source.id,
                    message_id=message_id,
                    text=text,
                    link=None,
                    received_at=datetime.now(UTC),
                ),
                self.rule,
                [self.recipient],
                self.notifier,
                self.dedupe_cache,
            )
            live_session.commit()

    def match_ids(self) -> list[int]:
        self.session.expire_all()
        return list(
            self.session.scalars(
                select(Match.telegram_message_id).order_by(Match.telegram_message_id)
            )
        )


def _msg(message_id: int, text: str, *, minutes_ago: float = 1.0) -> TelegramMessage:
    return TelegramMessage(
        id=message_id, text=text, date=datetime.now(UTC) - timedelta(minutes=minutes_ago)
    )


def _policy(**overrides: float) -> BackoffPolicy:
    values: dict[str, float] = {
        "jitter_ratio": 0.0,
        "stable_after_seconds": 0.0,  # every successful connection counts as stable
    }
    values.update(overrides)
    return BackoffPolicy(**values)  # type: ignore[arg-type]


async def test_refused_connections_never_exit_and_the_gap_is_backfilled_by_cursor(
    db_path: Path, session: Session
) -> None:
    telegram = FlakyTelegram(
        # Boot: Telegram refuses three times in a row (the DarkWake window).
        script=[_refused(), _refused(), _refused()],
        messages=[
            _msg(5, "Promoção antiga sem nada", minutes_ago=600),
            _msg(6, "Promoção iphone 13 por R$ 100", minutes_ago=30),
        ],
    )
    rig = Rig(session, db_path, telegram, policy=_policy())
    # The source was live-processed before this process started: cursor at 5.
    advance_cursor(session, rig.source.id, 5)
    session.commit()

    task = rig.start()

    # 1. Survives the refusals, connects on the 4th attempt and boots normally.
    await rig.wait_until_serving(1)
    assert not task.done()
    assert rig.sleeps == [5, 10, 20]
    assert telegram.connect_calls == 4
    assert rig.lifecycle.started
    assert rig.handler_registrations == 1
    assert telegram.iter_recent_calls == 1  # the 7-day scan ran once, at boot
    assert len(rig.bot.sent) == 1  # message 6: the restart catch-up, notified once

    # 2. A live message, then the link dies with the error from the production log
    #    while more messages arrive on Telegram's side.
    await rig.live_message(7, "Promoção iphone 14 por R$ 200")
    assert len(rig.bot.sent) == 2
    telegram.messages.append(_msg(8, "Promoção iphone 15 por R$ 300"))  # missed: link down
    telegram.messages.append(_msg(9, "conversa sem promoção"))  # missed, discarded
    telegram.refuse_next(2)  # and it stays refused for a while
    rig.sleeps.clear()
    telegram.drop()

    # 3. Reconnects inside the same process (no exit, no new handler, no rescan).
    await rig.wait_until_serving(2)
    assert not task.done()
    assert rig.sleeps == [5, 10, 20]  # drop -> two refusals, then it works
    assert rig.handler_registrations == 1
    assert telegram.iter_recent_calls == 1  # NOT the 7-day scan again
    # Backfill used the persisted cursor (5 at boot, 7 after the live message),
    # not a 7-day window.
    assert telegram.iter_messages_min_ids == [5, 7]
    assert get_cursor(session, rig.source.id) == 9

    # 4. Message 8 notified exactly once; nothing was sent twice anywhere.
    assert len(rig.bot.sent) == 3
    assert rig.match_ids() == [6, 7, 8]
    assert len({text for _, text in rig.bot.sent}) == 3

    # 5. The watchdog and the supervisor can both trigger a catch-up for the same
    #    reconnect; the lock + cursor make the second one a no-op.
    await asyncio.gather(rig.lifecycle.catch_up(), rig.lifecycle.catch_up())
    assert len(rig.bot.sent) == 3

    # 6. SIGTERM (stop_event) while serving ends cleanly.
    rig.stop_event.set()
    assert await asyncio.wait_for(task, 5) is SupervisorOutcome.STOPPED


async def test_escalates_to_blocked_only_at_the_ceiling_and_never_boots_the_pipeline(
    db_path: Path, session: Session
) -> None:
    telegram = FlakyTelegram(script=[_refused() for _ in range(100)])
    rig = Rig(session, db_path, telegram, policy=_policy(max_consecutive_failures=6))

    outcome = await asyncio.wait_for(rig.supervisor.run(), 5)

    assert outcome is SupervisorOutcome.BLOCKED
    assert telegram.connect_calls == 6
    assert rig.sleeps == [5, 10, 20, 40, 80]
    assert not rig.lifecycle.started
    assert rig.handler_registrations == 0
    assert rig.bot.sent == []


async def test_a_new_source_still_never_alerts_retroactively_after_boot_refusals(
    db_path: Path, session: Session
) -> None:
    """S6-04 must not regress: the retries happen *before* boot, and boot still
    only initializes a cursor for a source that has none.
    """
    telegram = FlakyTelegram(
        script=[_refused(), _refused()],
        messages=[_msg(1, "Promoção iphone 13 por R$ 100", minutes_ago=60)],
    )
    rig = Rig(session, db_path, telegram, policy=_policy())

    task = rig.start()
    await rig.wait_until_serving(1)

    assert rig.bot.sent == []
    assert get_cursor(session, rig.source.id) == 1
    session.expire_all()
    deliveries = list(session.scalars(select(Delivery)))
    assert [delivery.status for delivery in deliveries] == ["historical"]

    rig.stop_event.set()
    assert await asyncio.wait_for(task, 5) is SupervisorOutcome.STOPPED


async def test_a_catch_up_cut_short_by_the_network_is_retried_and_notifies_once(
    db_path: Path, session: Session
) -> None:
    telegram = FlakyTelegram(messages=[_msg(1, "Promoção antiga", minutes_ago=600)])
    rig = Rig(session, db_path, telegram, policy=_policy())
    advance_cursor(session, rig.source.id, 1)
    session.commit()

    task = rig.start()
    await rig.wait_until_serving(1)
    assert rig.bot.sent == []

    telegram.messages.append(_msg(2, "Promoção iphone 14 por R$ 200"))
    telegram.iter_messages_failures = 1  # the link drops again *during* the catch-up
    telegram.drop()

    await rig.wait_until_serving(2)
    assert not task.done()
    assert telegram.connect_calls == 3  # boot, the drop, and the retry after the failed catch-up
    assert len(rig.bot.sent) == 1  # exactly once, despite the interrupted first attempt
    assert rig.match_ids() == [2]

    rig.stop_event.set()
    assert await asyncio.wait_for(task, 5) is SupervisorOutcome.STOPPED


async def test_a_historical_scan_cut_short_is_redone_for_that_source_only_once(
    db_path: Path, session: Session
) -> None:
    three_days = 3 * 24 * 60
    telegram = FlakyTelegram(
        messages=[_msg(1, "Promoção iphone 13 por R$ 100", minutes_ago=three_days)]
    )
    telegram.iter_recent_failures = 1  # the very first scan dies with a ConnectionError
    rig = Rig(session, db_path, telegram, policy=_policy())
    advance_cursor(
        session, rig.source.id, 1
    )  # a known source: boot reads by cursor, not iter_recent
    session.commit()

    task = rig.start()
    await rig.wait_until_serving(1)
    assert telegram.iter_recent_calls == 1
    assert rig.match_ids() == []  # the scan did not finish

    telegram.drop()
    await rig.wait_until_serving(2)
    assert telegram.iter_recent_calls == 2  # the reconnect finished the missing scan
    assert rig.match_ids() == [1]
    assert rig.bot.sent == []  # historical: never an alert

    telegram.drop()
    await rig.wait_until_serving(3)
    assert telegram.iter_recent_calls == 2  # done; no full rescan on later reconnects

    rig.stop_event.set()
    assert await asyncio.wait_for(task, 5) is SupervisorOutcome.STOPPED
