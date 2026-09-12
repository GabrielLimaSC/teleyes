from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from sqlalchemy import func, select
from sqlalchemy.orm import Session, sessionmaker

from app.pipeline import IncomingMessage, ListenerSource, catch_up_since_cursor, process_message
from models import Match, Recipient, Rule, Source
from models.db import get_engine, get_sessionmaker
from packages.notifications.bot import BotNotifier
from packages.notifications.fakes import FakeBotClient
from packages.rules.dedupe import DedupeCache
from packages.telegram.adapter import AdapterState, TelegramAdapter
from packages.telegram.cursor import TelegramMessage, get_cursor
from packages.telegram.fakes import FakeTelegramClient


async def _fake_sleep(seconds: float) -> None:
    return None


def _msg(
    message_id: int, text: str = "Promoção iphone por R$ 100", minutes_ago: float = 0.0
) -> TelegramMessage:
    return TelegramMessage(
        id=message_id, text=text, date=datetime.now(UTC) - timedelta(minutes=minutes_ago)
    )


@pytest.fixture
def session_factory(db_path: Path, session: Session) -> sessionmaker[Session]:
    # Depends on `session` only to guarantee `alembic upgrade head` already ran
    # against `db_path` — a separate engine/sessionmaker bound to the same
    # sqlite file, since `catch_up_since_cursor` opens its own short-lived
    # sessions rather than sharing the caller's.
    return get_sessionmaker(get_engine(f"sqlite:///{db_path}"))


def _seed(session: Session) -> tuple[Source, Rule, Recipient]:
    source = Source(name="Grupo Teste", telegram_chat_id="-100123")
    rule = Rule(name="iPhone", include_terms="iphone")
    recipient = Recipient(name="Gabriel", telegram_chat_id="999", allowlisted=True)
    session.add_all([source, rule, recipient])
    session.commit()
    return source, rule, recipient


async def test_process_message_advances_cursor_even_when_discarded(session: Session) -> None:
    source, rule, recipient = _seed(session)
    notifier = BotNotifier(bot_token="token", client=FakeBotClient(), allowlisted_chat_ids={"999"})

    await process_message(
        session,
        IncomingMessage(
            source_id=source.id,
            message_id=5,
            text="Samsung Galaxy em promoção",  # doesn't match the "iphone" rule
            link=None,
            received_at=datetime.now(UTC),
        ),
        rule,
        [recipient],
        notifier,
        DedupeCache(),
    )
    session.commit()

    # A discard still means "we've seen up to message 5" — a later backfill
    # must not re-fetch it just because it never matched.
    assert get_cursor(session, source.id) == 5


async def test_catch_up_recovers_missed_messages_through_the_real_pipeline(
    session: Session, session_factory: sessionmaker[Session]
) -> None:
    source, rule, recipient = _seed(session)
    client = FakeTelegramClient(
        messages=[
            _msg(1, text="Promoção iphone 13 por R$ 100"),
            _msg(2, text="Promoção iphone 14 por R$ 200"),
            _msg(3, text="sem termo nenhum"),
        ]
    )
    bot_client = FakeBotClient()
    notifier = BotNotifier(bot_token="token", client=bot_client, allowlisted_chat_ids={"999"})
    listener_source = ListenerSource(
        source_id=source.id, chat_id="-100123", rules=[rule], recipients=[recipient]
    )

    results = await catch_up_since_cursor(
        session_factory, client, listener_source, notifier, DedupeCache()
    )

    assert [r.match is not None for r in results] == [True, True, False]
    assert get_cursor(session, source.id) == 3
    assert session.scalar(select(Match.id).order_by(Match.id)) is not None
    assert len(bot_client.sent) == 2


async def test_restart_does_not_replay_a_message_already_seen_live(
    session: Session, session_factory: sessionmaker[Session]
) -> None:
    """A process restart's startup catch-up must not re-notify what the prior
    run already delivered live — this is exactly `process_message`'s cursor
    advance (checked above) closing the gap `catch_up_since_cursor` alone
    cannot: without it, a message handled live but never backfilled would
    still be at cursor=0, and a restart's catch-up would "recover" it again.
    """
    source, rule, recipient = _seed(session)
    notifier = BotNotifier(bot_token="token", client=FakeBotClient(), allowlisted_chat_ids={"999"})
    dedupe_cache = DedupeCache()

    # Message 1 arrives live, in the same process, exactly like the real
    # Telethon event handler in scripts/run_pipeline_demo.py would deliver it.
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

    # "Restart": a fresh dedupe cache (in-memory, lost on restart) and a fresh
    # catch-up call, as if this were the new process's startup recovery. The
    # fake client's history includes message 1 (Telegram still has it) plus
    # message 2, which genuinely arrived while the process was down.
    fresh_dedupe_cache = DedupeCache()
    client = FakeTelegramClient(messages=[_msg(1), _msg(2)])
    listener_source = ListenerSource(
        source_id=source.id, chat_id="-100123", rules=[rule], recipients=[recipient]
    )

    results = await catch_up_since_cursor(
        session_factory, client, listener_source, notifier, fresh_dedupe_cache
    )

    # Only message 2 is "new" from the cursor's point of view — message 1 is
    # never re-fetched, so it can't be re-notified even with a cold dedupe cache.
    assert [r.match.message_text for r in results if r.match is not None] == [
        "Promoção iphone por R$ 100"
    ]
    assert len(results) == 1
    # Two total: one from the live message, one from the recovered message —
    # never a third from re-processing message 1 during catch-up.
    assert session.scalar(select(func.count()).select_from(Match)) == 2


async def test_short_disconnect_recovers_the_gap_via_adapter_reconnect(
    session: Session, session_factory: sessionmaker[Session]
) -> None:
    source, rule, recipient = _seed(session)
    notifier = BotNotifier(bot_token="token", client=FakeBotClient(), allowlisted_chat_ids={"999"})
    dedupe_cache = DedupeCache()
    listener_source = ListenerSource(
        source_id=source.id, chat_id="-100123", rules=[rule], recipients=[recipient]
    )

    client = FakeTelegramClient(messages=[_msg(1)])
    adapter = TelegramAdapter(api_id=1, api_hash="hash", client=client, sleep=_fake_sleep)

    assert await adapter.connect() is AdapterState.CONNECTED
    startup_results = await catch_up_since_cursor(
        session_factory, client, listener_source, notifier, dedupe_cache
    )
    assert len(startup_results) == 1
    assert get_cursor(session, source.id) == 1

    await adapter.disconnect()
    assert adapter.state is AdapterState.RECONNECTING

    # Messages 2-3 arrive during the drop.
    client.messages.extend([_msg(2), _msg(3)])

    assert await adapter.reconnect() is AdapterState.CONNECTED
    recovered = await catch_up_since_cursor(
        session_factory, client, listener_source, notifier, dedupe_cache
    )

    assert len(recovered) == 2
    assert get_cursor(session, source.id) == 3


async def test_catch_up_respects_max_messages_bound(
    session: Session, session_factory: sessionmaker[Session]
) -> None:
    source, rule, recipient = _seed(session)
    notifier = BotNotifier(bot_token="token", client=FakeBotClient(), allowlisted_chat_ids={"999"})
    client = FakeTelegramClient(messages=[_msg(i) for i in range(1, 11)])
    listener_source = ListenerSource(
        source_id=source.id, chat_id="-100123", rules=[rule], recipients=[recipient]
    )

    results = await catch_up_since_cursor(
        session_factory, client, listener_source, notifier, DedupeCache(), max_messages=3
    )

    assert len(results) == 3
    # The remaining 7 are permanently skipped, not queued — same bounded
    # contract as `backfill_since_cursor` itself.
    assert get_cursor(session, source.id) == 3


async def test_catch_up_evaluates_every_rule_without_starving_later_rules(
    session: Session, session_factory: sessionmaker[Session]
) -> None:
    """`ProcessingCursor` is unique on `source_id` alone (one per source, not
    per source+rule) — S5-09 found that fetching messages once per (source,
    rule) pair would advance that single shared cursor on the first rule's
    fetch, leaving nothing left to recover for every rule after it. The fix:
    `backfill_since_cursor` runs exactly once per source, and its result is
    then evaluated against every rule.
    """
    source, first_rule, recipient = _seed(session)
    second_rule = Rule(name="Notebook", include_terms="notebook")
    session.add(second_rule)
    session.commit()

    client = FakeTelegramClient(
        messages=[_msg(1, text="iphone por 100"), _msg(2, text="notebook por 200")]
    )
    notifier = BotNotifier(bot_token="token", client=FakeBotClient(), allowlisted_chat_ids={"999"})
    listener_source = ListenerSource(
        source_id=source.id,
        chat_id="-100123",
        rules=[first_rule, second_rule],
        recipients=[recipient],
    )

    results = await catch_up_since_cursor(
        session_factory, client, listener_source, notifier, DedupeCache()
    )

    # 2 messages x 2 rules = 4 evaluations; each message matches exactly one
    # of the two rules.
    assert len(results) == 4
    assert sum(1 for r in results if r.match is not None) == 2
    assert get_cursor(session, source.id) == 2
