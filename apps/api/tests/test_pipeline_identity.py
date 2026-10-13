from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.pipeline import IncomingMessage, process_message
from models import Delivery, Match, ProcessingCursor, Recipient, Rule, Source
from models.db import get_engine, get_sessionmaker
from packages.notifications.bot import BotNotifier
from packages.notifications.fakes import FakeBotClient
from packages.rules.dedupe import DedupeCache


def _seed(session: Session) -> tuple[int, int, int]:
    source = Source(name="Source", telegram_chat_id="-1001")
    rule = Rule(name="Rule", include_terms="promo")
    recipient = Recipient(name="Recipient", telegram_chat_id="999", allowlisted=True)
    session.add_all([source, rule, recipient])
    session.commit()
    return source.id, rule.id, recipient.id


def _message(source_id: int, message_id: int | None = 42) -> IncomingMessage:
    return IncomingMessage(
        source_id=source_id,
        message_id=message_id,
        text="Promo por R$ 100",
        link=None,
        received_at=datetime(2026, 9, 13, 12, 0, tzinfo=UTC),
    )


def _notifier(client: FakeBotClient) -> BotNotifier:
    return BotNotifier(bot_token="token", client=client, allowlisted_chat_ids={"999"})


async def test_same_persistent_identity_is_duplicate_with_fresh_session_and_cache(
    session: Session, db_path: Path
) -> None:
    source_id, rule_id, recipient_id = _seed(session)
    client = FakeBotClient()

    first = await process_message(
        session,
        _message(source_id),
        session.get_one(Rule, rule_id),
        [session.get_one(Recipient, recipient_id)],
        _notifier(client),
        DedupeCache(),
    )
    session.commit()

    session_factory = get_sessionmaker(get_engine(f"sqlite:///{db_path}"))
    with session_factory() as fresh_session:
        duplicate = await process_message(
            fresh_session,
            _message(source_id),
            fresh_session.get_one(Rule, rule_id),
            [fresh_session.get_one(Recipient, recipient_id)],
            _notifier(client),
            DedupeCache(),
        )
        # The savepoint absorbed the uniqueness conflict: this same outer
        # transaction remains queryable and committable.
        assert fresh_session.scalar(select(func.count()).select_from(Match)) == 1
        fresh_session.commit()

    assert first.match is not None
    assert duplicate.match is None
    assert duplicate.reason == "duplicate"
    assert session.scalar(select(func.count()).select_from(Match)) == 1
    assert session.scalar(select(func.count()).select_from(Delivery)) == 1
    assert client.sent == [("999", "Promo por R$ 100")]


async def test_same_message_can_match_two_rules_with_shared_memory_cache(session: Session) -> None:
    source_id, first_rule_id, recipient_id = _seed(session)
    second_rule = Rule(name="Second rule", include_terms="promo")
    session.add(second_rule)
    session.commit()
    client = FakeBotClient()
    cache = DedupeCache()

    for rule_id in (first_rule_id, second_rule.id):
        result = await process_message(
            session,
            _message(source_id),
            session.get_one(Rule, rule_id),
            [session.get_one(Recipient, recipient_id)],
            _notifier(client),
            cache,
        )
        assert result.match is not None
    session.commit()

    matches = list(session.scalars(select(Match).order_by(Match.rule_id)))
    assert len(matches) == 2
    assert {match.rule_id for match in matches} == {first_rule_id, second_rule.id}
    assert {match.telegram_message_id for match in matches} == {42}
    assert len(client.sent) == 2


async def test_same_message_id_in_different_sources_does_not_conflict(session: Session) -> None:
    """Both sources still get their own real `Match` row (identity is a
    per-source thing, S6-01) — but since `_message()` gives both the exact
    same rule/price/timestamp, this is also the canonical S7-11 grouping
    scenario: two different sources "posting the same real promotion" within
    the window. Only the first send is real; the second is grouped, not
    re-sent.
    """
    first_source_id, rule_id, recipient_id = _seed(session)
    second_source = Source(name="Other source", telegram_chat_id="-1002")
    session.add(second_source)
    session.commit()
    client = FakeBotClient()
    cache = DedupeCache()

    for source_id in (first_source_id, second_source.id):
        result = await process_message(
            session,
            _message(source_id),
            session.get_one(Rule, rule_id),
            [session.get_one(Recipient, recipient_id)],
            _notifier(client),
            cache,
        )
        assert result.match is not None
    session.commit()

    assert session.scalar(select(func.count()).select_from(Match)) == 2
    assert len(client.sent) == 1


async def test_message_without_identity_keeps_explicit_memory_only_dedupe(
    session: Session, db_path: Path
) -> None:
    source_id, rule_id, recipient_id = _seed(session)
    client = FakeBotClient()
    cache = DedupeCache()

    first = await process_message(
        session,
        _message(source_id, message_id=None),
        session.get_one(Rule, rule_id),
        [session.get_one(Recipient, recipient_id)],
        _notifier(client),
        cache,
    )
    same_process = await process_message(
        session,
        _message(source_id, message_id=None),
        session.get_one(Rule, rule_id),
        [session.get_one(Recipient, recipient_id)],
        _notifier(client),
        cache,
    )
    session.commit()

    session_factory = get_sessionmaker(get_engine(f"sqlite:///{db_path}"))
    with session_factory() as fresh_session:
        fresh_process = await process_message(
            fresh_session,
            _message(source_id, message_id=None),
            fresh_session.get_one(Rule, rule_id),
            [fresh_session.get_one(Recipient, recipient_id)],
            _notifier(client),
            DedupeCache(),
        )
        fresh_session.commit()

    assert first.match is not None
    assert same_process.reason == "duplicate"
    assert fresh_process.match is not None
    assert session.scalar(select(func.count()).select_from(Match)) == 2
    assert session.scalar(select(func.count()).select_from(ProcessingCursor)) == 0
    assert set(session.scalars(select(Match.telegram_message_id))) == {None}
