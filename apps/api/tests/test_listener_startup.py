"""Integration coverage for S6-04: the listener-boot decision
(`app.pipeline.prepare_source_at_startup`) that a brand-new source must never
run the notifying reconnect catch-up, while a genuinely reconnecting source
still must — exercised together with `run_historical_scan` and a live
`process_message`, not just `prepare_source_at_startup` in isolation, so the
whole startup sequence `scripts/run_listener.py` drives is actually proven,
not only its pieces.
"""

from datetime import UTC, datetime, timedelta
from pathlib import Path

from sqlalchemy import func, select
from sqlalchemy.orm import Session, sessionmaker

from app.pipeline import (
    IncomingMessage,
    ListenerSource,
    prepare_source_at_startup,
    process_message,
    run_historical_scan,
)
from models import Delivery, Match, Recipient, Rule, Source
from models.db import get_engine, get_sessionmaker
from packages.notifications.bot import BotNotifier
from packages.notifications.fakes import FakeBotClient
from packages.rules.dedupe import DedupeCache
from packages.telegram.cursor import TelegramMessage, get_cursor
from packages.telegram.fakes import FakeTelegramClient


def _msg(message_id: int, text: str, *, date: datetime) -> TelegramMessage:
    return TelegramMessage(id=message_id, text=text, date=date)


def _seed(session: Session) -> tuple[Source, Rule, Recipient]:
    source = Source(name="Grupo Teste", telegram_chat_id="-100123")
    rule = Rule(name="iPhone", include_terms="iphone")
    recipient = Recipient(name="Gabriel", telegram_chat_id="999", allowlisted=True)
    session.add_all([source, rule, recipient])
    session.commit()
    return source, rule, recipient


def _session_factory(db_path: Path) -> sessionmaker[Session]:
    return get_sessionmaker(get_engine(f"sqlite:///{db_path}"))


async def test_a_brand_new_source_never_notifies_at_boot(
    db_path: Path, session: Session
) -> None:
    """The exact bug reported live during S6-03 homologation: a source with
    no persisted `ProcessingCursor` must not have its whole recent history
    treated as "missed during a disconnect" and notified for real.
    """
    source, rule, recipient = _seed(session)
    session_factory = _session_factory(db_path)
    now = datetime.now(UTC)
    client = FakeTelegramClient(
        messages=[_msg(1, "Promoção iphone por R$ 100", date=now - timedelta(hours=1))]
    )
    bot_client = FakeBotClient()
    notifier = BotNotifier(bot_token="token", client=bot_client, allowlisted_chat_ids={"999"})
    listener_source = ListenerSource(
        source_id=source.id, chat_id="-100123", rules=[rule], recipients=[recipient]
    )

    outcome = await prepare_source_at_startup(
        session_factory, client, listener_source, notifier, DedupeCache()
    )

    assert outcome.initialized is True
    assert outcome.recovered == []
    assert bot_client.sent == []
    assert session.scalar(select(func.count()).select_from(Match)) == 0
    # The cursor is not left at 0/unset either — it's initialized at the
    # chat's current head (message 1), so a future real reconnect catch-up
    # never re-fetches this same message.
    assert get_cursor(session, source.id) == 1


async def test_a_new_sources_recent_history_still_surfaces_via_the_historical_scan(
    db_path: Path, session: Session
) -> None:
    source, rule, recipient = _seed(session)
    session_factory = _session_factory(db_path)
    now = datetime.now(UTC)
    client = FakeTelegramClient(
        messages=[_msg(1, "Promoção iphone por R$ 100", date=now - timedelta(hours=1))]
    )
    bot_client = FakeBotClient()
    notifier = BotNotifier(bot_token="token", client=bot_client, allowlisted_chat_ids={"999"})
    listener_source = ListenerSource(
        source_id=source.id, chat_id="-100123", rules=[rule], recipients=[recipient]
    )

    await prepare_source_at_startup(
        session_factory, client, listener_source, notifier, DedupeCache()
    )
    historical_results = await run_historical_scan(
        session_factory, client, listener_source, before=now
    )

    assert sum(1 for r in historical_results if r.match is not None) == 1
    assert bot_client.sent == []
    deliveries = list(session.scalars(select(Delivery)))
    assert len(deliveries) == 1
    assert deliveries[0].status == "historical"


async def test_a_genuinely_new_live_message_after_startup_still_sends_one_alert(
    db_path: Path, session: Session
) -> None:
    source, rule, recipient = _seed(session)
    session_factory = _session_factory(db_path)
    now = datetime.now(UTC)
    startup_client = FakeTelegramClient(
        messages=[_msg(1, "Promoção iphone antiga por R$ 50", date=now - timedelta(hours=1))]
    )
    bot_client = FakeBotClient()
    notifier = BotNotifier(bot_token="token", client=bot_client, allowlisted_chat_ids={"999"})
    listener_source = ListenerSource(
        source_id=source.id, chat_id="-100123", rules=[rule], recipients=[recipient]
    )
    dedupe_cache = DedupeCache()

    await prepare_source_at_startup(
        session_factory, startup_client, listener_source, notifier, dedupe_cache
    )

    live_result = await process_message(
        session,
        IncomingMessage(
            source_id=source.id,
            message_id=2,
            text="Promoção iphone nova por R$ 999",
            link=None,
            received_at=datetime.now(UTC),
        ),
        rule,
        [recipient],
        notifier,
        dedupe_cache,
    )
    session.commit()

    assert live_result.match is not None
    assert len(bot_client.sent) == 1


async def test_a_source_with_a_real_persisted_cursor_still_notifies_on_reconnect(
    db_path: Path, session: Session
) -> None:
    """Regression guard for S5-02: a source that really was live-processed
    before (a real persisted cursor exists) must keep getting the notifying
    recovery on the very next boot/reconnect — S6-04 must not silence that.
    """
    source, rule, recipient = _seed(session)
    session_factory = _session_factory(db_path)
    bot_client = FakeBotClient()
    notifier = BotNotifier(bot_token="token", client=bot_client, allowlisted_chat_ids={"999"})
    dedupe_cache = DedupeCache()
    listener_source = ListenerSource(
        source_id=source.id, chat_id="-100123", rules=[rule], recipients=[recipient]
    )

    # Message 1 arrives live, in the same process — same as the real
    # Telethon event handler in scripts/run_listener.py would deliver it,
    # persisting a real ProcessingCursor for this source.
    await process_message(
        session,
        IncomingMessage(
            source_id=source.id,
            message_id=1,
            text="iphone por 100",
            link=None,
            received_at=datetime.now(UTC),
        ),
        rule,
        [recipient],
        notifier,
        dedupe_cache,
    )
    session.commit()
    assert get_cursor(session, source.id) == 1

    # "Restart": a fresh dedupe cache and a fresh startup call. Message 2
    # genuinely arrived while the process was down.
    fresh_dedupe_cache = DedupeCache()
    client = FakeTelegramClient(
        messages=[
            _msg(1, "iphone por 100", date=datetime.now(UTC)),
            _msg(2, "iphone por 200", date=datetime.now(UTC)),
        ]
    )

    outcome = await prepare_source_at_startup(
        session_factory, client, listener_source, notifier, fresh_dedupe_cache
    )

    assert outcome.initialized is False
    assert len(outcome.recovered) == 1
    assert outcome.recovered[0].match is not None
    assert len(bot_client.sent) == 2  # one from the live message, one recovered
    assert get_cursor(session, source.id) == 2
