"""S13-04: the listener must not lose a match, nor alert twice, when SQLite is
write-locked by someone else (or by a sibling handler awaiting the network).

Real parts: the pipeline, `ListenerLifecycle`, a real SQLite file in WAL mode,
a second raw connection that really holds the write lock. Fake parts: the Bot
API (`FakeBotClient`/`SlowBotClient`) and the Telegram history fetcher.
"""

from __future__ import annotations

import asyncio
import sqlite3
import time
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path

import pytest
from sqlalchemy import event, func, select
from sqlalchemy.orm import Session, sessionmaker

from app import db_retry
from app.listener_lifecycle import ListenerLifecycle
from app.pipeline import IncomingMessage, ListenerSource, process_message_with_retry
from models import Delivery, Match, Recipient, Rule, Source
from models.db import get_engine, get_sessionmaker
from packages.notifications.bot import BotNotifier
from packages.notifications.fakes import FakeBotClient
from packages.rules.dedupe import DedupeCache
from packages.telegram.cursor import TelegramMessage, get_cursor
from packages.telegram.fakes import FakeTelegramClient


class SlowBotClient(FakeBotClient):
    """A Bot API that takes a while to answer, like the real one under load."""

    async def send_message(self, chat_id: str, text: str) -> None:
        await asyncio.sleep(0.4)
        await super().send_message(chat_id, text)


@pytest.fixture(autouse=True)
def fast_retries(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(db_retry, "DEFAULT_BASE_DELAY", 0.02)


@pytest.fixture
def short_busy_factory(db_path: Path, session: Session) -> sessionmaker[Session]:
    """Same database as `session`, but `busy_timeout` of 30 ms instead of 5 s so
    a held lock surfaces as `database is locked` quickly (production's 5 s is
    exactly what made the real incident so slow)."""
    engine = get_engine(f"sqlite:///{db_path}")

    @event.listens_for(engine, "connect")
    def _short_busy(dbapi_connection: sqlite3.Connection, _record: object) -> None:
        dbapi_connection.execute("PRAGMA busy_timeout=30")

    return get_sessionmaker(engine)


@contextmanager
def write_lock(db_path: Path) -> Iterator[sqlite3.Connection]:
    """A second connection that holds SQLite's write lock until released."""
    connection = sqlite3.connect(str(db_path), isolation_level=None)
    connection.execute("BEGIN IMMEDIATE")
    try:
        yield connection
    finally:
        connection.close()  # rolls back and releases


def _seed(session: Session) -> tuple[Source, Rule, Recipient]:
    source = Source(name="Grupo Teste", telegram_chat_id="-100123")
    rule = Rule(name="iPhone", include_terms="iphone")
    recipient = Recipient(name="Gabriel", telegram_chat_id="999", allowlisted=True)
    session.add_all([source, rule, recipient])
    session.commit()
    return source, rule, recipient


def _incoming(source: Source, message_id: int) -> IncomingMessage:
    return IncomingMessage(
        source_id=source.id,
        message_id=message_id,
        text=f"Promoção iphone {message_id} por R$ {message_id}0",
        link=None,
        received_at=datetime.now(UTC),
    )


def _notifier(client: FakeBotClient) -> BotNotifier:
    return BotNotifier(bot_token="token", client=client, allowlisted_chat_ids={"999"})


def _count(session: Session, model: type) -> int:
    session.expire_all()
    return session.scalar(select(func.count()).select_from(model)) or 0


async def test_sibling_handlers_do_not_deadlock_on_a_slow_bot_api(
    session: Session, db_path: Path
) -> None:
    """The measured root cause: handler A held the write lock across the Bot API
    call, handler B's synchronous wait for that lock froze the event loop A
    needed to finish, and B failed after busy_timeout (5 s) with "database is
    locked". With the write phase committed before the network phase both finish
    in about one bot round trip."""
    source, rule, recipient = _seed(session)
    factory = get_sessionmaker(get_engine(f"sqlite:///{db_path}"))  # real 5 s busy_timeout
    bot = SlowBotClient()
    notifier, cache = _notifier(bot), DedupeCache()

    started = time.monotonic()
    await asyncio.gather(
        *(
            process_message_with_retry(
                factory, _incoming(source, message_id), rule, [recipient], notifier, cache
            )
            for message_id in (1, 2, 3)
        )
    )
    elapsed = time.monotonic() - started

    assert elapsed < 2.0, f"handlers serialized on the write lock ({elapsed:.1f}s)"
    assert len(bot.sent) == 3
    assert _count(session, Match) == 3
    assert _count(session, Delivery) == 3
    assert get_cursor(session, source.id) == 3


async def test_match_survives_an_external_writer_and_alerts_exactly_once(
    session: Session, db_path: Path, short_busy_factory: sessionmaker[Session]
) -> None:
    source, rule, recipient = _seed(session)
    bot = FakeBotClient()
    notifier, cache = _notifier(bot), DedupeCache()

    async def release_later(connection: sqlite3.Connection) -> None:
        await asyncio.sleep(0.15)
        connection.execute("COMMIT")

    with write_lock(db_path) as locker:
        release = asyncio.create_task(release_later(locker))
        result = await process_message_with_retry(
            short_busy_factory, _incoming(source, 7), rule, [recipient], notifier, cache
        )
        await release

    assert result.match is not None
    assert len(bot.sent) == 1
    assert _count(session, Match) == 1
    assert get_cursor(session, source.id) == 7
    session.expire_all()
    assert [d.status for d in session.scalars(select(Delivery))] == ["sent"]

    # Restart: a cold dedupe cache and a fresh notifier must not alert again.
    again = await process_message_with_retry(
        short_busy_factory, _incoming(source, 7), rule, [recipient], _notifier(bot), DedupeCache()
    )
    assert again.match is None
    assert len(bot.sent) == 1
    assert _count(session, Match) == 1


async def test_delivery_record_is_retried_after_the_alert_already_left(
    session: Session, db_path: Path, short_busy_factory: sessionmaker[Session]
) -> None:
    """The lock appears *during* the network phase: the alert is sent, then the
    outcome write meets the lock. It must be retried, not lost, and never cause
    a second send."""
    source, rule, recipient = _seed(session)
    holder: dict[str, sqlite3.Connection] = {}

    class LockingBot(FakeBotClient):
        async def send_message(self, chat_id: str, text: str) -> None:
            await super().send_message(chat_id, text)
            conn = sqlite3.connect(str(db_path), isolation_level=None)
            conn.execute("BEGIN IMMEDIATE")
            holder["conn"] = conn
            asyncio.get_running_loop().call_later(0.1, conn.close)

    bot = LockingBot()
    result = await process_message_with_retry(
        short_busy_factory, _incoming(source, 9), rule, [recipient], _notifier(bot), DedupeCache()
    )
    await asyncio.sleep(0.15)

    assert result.deliveries_sent == 1
    assert len(bot.sent) == 1
    session.expire_all()
    assert [d.status for d in session.scalars(select(Delivery))] == ["sent"]


async def test_live_message_lost_to_a_long_lock_is_recovered_once_by_catch_up(
    session: Session, db_path: Path, short_busy_factory: sessionmaker[Session]
) -> None:
    """Retries exhausted: the live handler must not raise nor skip the rest; the
    periodic catch-up then recovers the message although a *later* message already
    moved the cursor past it, and nothing is alerted twice."""
    source, rule, recipient = _seed(session)
    bot = FakeBotClient()
    telegram = FakeTelegramClient(
        messages=[
            TelegramMessage(id=i, text=f"Promoção iphone {i} por R$ {i}0", date=datetime.now(UTC))
            for i in (10, 11)
        ]
    )
    listener_source = ListenerSource(
        source_id=source.id, chat_id="-100123", rules=[rule], recipients=[recipient]
    )
    lifecycle = ListenerLifecycle(
        session_factory=short_busy_factory,
        fetcher=telegram,
        sources=[listener_source],
        notifier=_notifier(bot),
        dedupe_cache=DedupeCache(),
        register_live_handler=lambda: None,
        printer=lambda _text: None,
    )
    lifecycle.started = True
    live = {m.id: m for m in telegram.messages}

    with write_lock(db_path):
        await lifecycle.handle_live_message(-100123, live[10])  # exhausts, must not raise
    assert _count(session, Match) == 0
    assert bot.sent == []

    await lifecycle.handle_live_message(-100123, live[11])  # lock gone: processed, cursor -> 11
    assert get_cursor(session, source.id) == 11
    assert len(bot.sent) == 1

    await lifecycle.catch_up()  # message 10 is below the cursor but remembered as failed

    assert sorted((m.telegram_message_id or 0) for m in session.scalars(select(Match))) == [10, 11]
    assert len(bot.sent) == 2

    await lifecycle.catch_up()  # nothing left to recover; no repeat alert
    assert len(bot.sent) == 2
    assert _count(session, Delivery) == 2
