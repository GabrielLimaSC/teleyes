from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path

from sqlalchemy import func, select
from sqlalchemy.orm import Session, sessionmaker

from app.pipeline import IncomingMessage, ListenerSource, process_message, run_historical_scan
from models import Delivery, Match, Recipient, Rule, Source
from models.db import get_engine, get_sessionmaker
from packages.metrics.counters import MetricCounter
from packages.notifications.bot import BotNotifier
from packages.notifications.fakes import FakeBotClient
from packages.rules.dedupe import DedupeCache
from packages.telegram.cursor import TelegramMessage, advance_cursor, get_cursor
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


@dataclass
class Fixture:
    session_factory: sessionmaker[Session]
    source: Source
    rule: Rule
    recipient: Recipient


def _fixture(db_path: Path, session: Session) -> Fixture:
    source, rule, recipient = _seed(session)
    session_factory = get_sessionmaker(get_engine(f"sqlite:///{db_path}"))
    return Fixture(session_factory, source, rule, recipient)


async def test_historical_scan_persists_matches_without_advancing_cursor(
    db_path: Path, session: Session
) -> None:
    fixture = _fixture(db_path, session)
    now = datetime.now(UTC)
    client = FakeTelegramClient(
        messages=[_msg(1, "Promoção iphone por R$ 100", date=now - timedelta(hours=1))]
    )
    listener_source = ListenerSource(
        source_id=fixture.source.id,
        chat_id="-100123",
        rules=[fixture.rule],
        recipients=[fixture.recipient],
    )

    results = await run_historical_scan(
        fixture.session_factory, client, listener_source, before=now
    )

    assert len(results) == 1
    assert results[0].match is not None
    # A live cursor advance would make a later real backfill skip this
    # message — S6-02's scan must never do that.
    assert get_cursor(session, fixture.source.id) == 0


async def test_historical_scan_creates_one_delivery_per_recipient_never_sent(
    db_path: Path, session: Session
) -> None:
    fixture = _fixture(db_path, session)
    now = datetime.now(UTC)
    client = FakeTelegramClient(
        messages=[_msg(1, "Promoção iphone por R$ 100", date=now - timedelta(hours=1))]
    )
    listener_source = ListenerSource(
        source_id=fixture.source.id,
        chat_id="-100123",
        rules=[fixture.rule],
        recipients=[fixture.recipient],
    )

    await run_historical_scan(fixture.session_factory, client, listener_source, before=now)

    deliveries = list(session.scalars(select(Delivery)))
    assert len(deliveries) == 1
    assert deliveries[0].status == "historical"
    assert deliveries[0].delivered_at is None


async def test_historical_scan_never_calls_the_bot(db_path: Path, session: Session) -> None:
    """`run_historical_scan`/`process_historical_message` take no `BotNotifier`
    parameter at all — structurally impossible to notify. This test still
    wires a real notifier around a live call on the same fixture to prove the
    fake bot client stays untouched by the historical path specifically.
    """
    fixture = _fixture(db_path, session)
    now = datetime.now(UTC)
    client = FakeTelegramClient(
        messages=[_msg(1, "Promoção iphone por R$ 100", date=now - timedelta(hours=1))]
    )
    listener_source = ListenerSource(
        source_id=fixture.source.id,
        chat_id="-100123",
        rules=[fixture.rule],
        recipients=[fixture.recipient],
    )
    bot_client = FakeBotClient()

    await run_historical_scan(fixture.session_factory, client, listener_source, before=now)

    assert bot_client.sent == []


async def test_historical_scan_ignores_a_rule_created_after_the_sources_cursor_advanced(
    db_path: Path, session: Session
) -> None:
    fixture = _fixture(db_path, session)
    advance_cursor(session, fixture.source.id, 50)
    session.commit()

    new_rule = Rule(name="Notebook", include_terms="notebook")
    session.add(new_rule)
    session.commit()

    now = datetime.now(UTC)
    client = FakeTelegramClient(
        messages=[_msg(10, "Promoção notebook por R$ 100", date=now - timedelta(hours=1))]
    )
    listener_source = ListenerSource(
        source_id=fixture.source.id,
        chat_id="-100123",
        rules=[new_rule],
        recipients=[fixture.recipient],
    )

    results = await run_historical_scan(
        fixture.session_factory, client, listener_source, before=now
    )

    assert len(results) == 1
    assert results[0].match is not None
    # The cursor stays exactly where the live path left it — a historical
    # scan for a brand-new rule must not be starved or blocked by it, and
    # must not move it either.
    assert get_cursor(session, fixture.source.id) == 50


async def test_historical_scan_evaluates_every_rule_for_the_same_message(
    db_path: Path, session: Session
) -> None:
    fixture = _fixture(db_path, session)
    second_rule = Rule(name="Promoção qualquer", include_terms="promoção")
    session.add(second_rule)
    session.commit()

    now = datetime.now(UTC)
    client = FakeTelegramClient(
        messages=[_msg(1, "Promoção iphone por R$ 100", date=now - timedelta(hours=1))]
    )
    listener_source = ListenerSource(
        source_id=fixture.source.id,
        chat_id="-100123",
        rules=[fixture.rule, second_rule],
        recipients=[fixture.recipient],
    )

    results = await run_historical_scan(
        fixture.session_factory, client, listener_source, before=now
    )

    assert sum(1 for r in results if r.match is not None) == 2
    matches = list(session.scalars(select(Match)))
    assert {match.rule_id for match in matches} == {fixture.rule.id, second_rule.id}


async def test_repeating_the_historical_scan_with_a_fresh_session_does_not_duplicate(
    db_path: Path, session: Session
) -> None:
    fixture = _fixture(db_path, session)
    now = datetime.now(UTC)
    client = FakeTelegramClient(
        messages=[_msg(1, "Promoção iphone por R$ 100", date=now - timedelta(hours=1))]
    )
    listener_source = ListenerSource(
        source_id=fixture.source.id,
        chat_id="-100123",
        rules=[fixture.rule],
        recipients=[fixture.recipient],
    )

    await run_historical_scan(fixture.session_factory, client, listener_source, before=now)
    # Simulates a listener restart: a brand-new session_factory/engine bound
    # to the same database file, no cache carried over from the first run.
    fresh_session_factory = get_sessionmaker(get_engine(f"sqlite:///{db_path}"))
    second_results = await run_historical_scan(
        fresh_session_factory, client, listener_source, before=now
    )

    assert all(r.match is None for r in second_results)
    assert session.scalar(select(func.count()).select_from(Match)) == 1
    assert session.scalar(select(func.count()).select_from(Delivery)) == 1


async def test_rejected_historical_messages_persist_no_content_and_no_metric(
    db_path: Path, session: Session
) -> None:
    fixture = _fixture(db_path, session)
    now = datetime.now(UTC)
    client = FakeTelegramClient(
        messages=[_msg(1, "Samsung Galaxy em promoção", date=now - timedelta(hours=1))]
    )
    listener_source = ListenerSource(
        source_id=fixture.source.id,
        chat_id="-100123",
        rules=[fixture.rule],
        recipients=[fixture.recipient],
    )

    results = await run_historical_scan(
        fixture.session_factory, client, listener_source, before=now
    )

    assert results == [
        r for r in results if r.match is None
    ]  # nothing matched the "iphone" rule
    assert session.scalar(select(func.count()).select_from(Match)) == 0
    # The historical path must never inflate the live metric counters — a
    # repeated scan on every listener restart would otherwise keep counting
    # the same rejected message over and over.
    assert session.scalar(select(func.count()).select_from(MetricCounter)) == 0


async def test_live_event_after_a_historical_scan_still_sends_a_real_alert(
    db_path: Path, session: Session
) -> None:
    fixture = _fixture(db_path, session)
    now = datetime.now(UTC)
    historical_client = FakeTelegramClient(
        messages=[_msg(1, "Promoção iphone antiga por R$ 50", date=now - timedelta(hours=2))]
    )
    listener_source = ListenerSource(
        source_id=fixture.source.id,
        chat_id="-100123",
        rules=[fixture.rule],
        recipients=[fixture.recipient],
    )
    await run_historical_scan(
        fixture.session_factory, historical_client, listener_source, before=now
    )

    bot_client = FakeBotClient()
    notifier = BotNotifier(bot_token="token", client=bot_client, allowlisted_chat_ids={"999"})
    live_result = await process_message(
        session,
        IncomingMessage(
            source_id=fixture.source.id,
            message_id=2,
            text="Promoção iphone nova por R$ 999",
            link=None,
            received_at=datetime.now(UTC),
        ),
        fixture.rule,
        [fixture.recipient],
        notifier,
        DedupeCache(),
    )
    session.commit()

    assert live_result.match is not None
    assert len(bot_client.sent) == 1
    assert session.scalar(select(func.count()).select_from(Match)) == 2
