"""S7-11 — mechanism 1: a different source posting the exact same rule+price
within GROUPING_WINDOW of another match that was already really sent gets
persisted normally (S6-01 identity intact) but is never re-notified.
"""

from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.pipeline import GROUPED_DELIVERY_STATUS, GROUPING_WINDOW, IncomingMessage, process_message
from models import Delivery, Match, Recipient, Rule, Source
from packages.notifications.bot import BotNotifier
from packages.notifications.fakes import FakeBotClient
from packages.rules.dedupe import DedupeCache


def _seed_two_sources(session: Session) -> tuple[Source, Source, Rule, Recipient]:
    source_a = Source(name="Wolf Ofertas", telegram_chat_id="-1001")
    source_b = Source(name="CMdias", telegram_chat_id="-1002")
    rule = Rule(name="RTX 5070", include_terms="rtx 5070")
    recipient = Recipient(name="Gabriel", telegram_chat_id="999", allowlisted=True)
    session.add_all([source_a, source_b, rule, recipient])
    session.commit()
    return source_a, source_b, rule, recipient


def _msg(source_id: int, *, text: str, minutes_offset: float, message_id: int) -> IncomingMessage:
    base = datetime(2026, 9, 14, 12, 0, tzinfo=UTC)
    return IncomingMessage(
        source_id=source_id,
        message_id=message_id,
        text=text,
        link=None,
        received_at=base + timedelta(minutes=minutes_offset),
    )


async def test_second_source_within_the_window_is_grouped_not_renotified(session: Session) -> None:
    source_a, source_b, rule, recipient = _seed_two_sources(session)
    client = FakeBotClient()
    notifier = BotNotifier(bot_token="token", client=client, allowlisted_chat_ids={"999"})
    dedupe_cache = DedupeCache()

    first = await process_message(
        session,
        _msg(source_a.id, text="RTX 5070 por R$ 4000 na Amazon", minutes_offset=0, message_id=1),
        rule,
        [recipient],
        notifier,
        dedupe_cache,
    )
    session.commit()

    second = await process_message(
        session,
        _msg(
            source_b.id,
            text="RTX 5070 por R$ 4000 no Mercado Livre",
            minutes_offset=5,
            message_id=2,
        ),
        rule,
        [recipient],
        notifier,
        dedupe_cache,
    )
    session.commit()

    assert first.match is not None
    assert second.match is not None
    # Both sources kept their own real Match row — grouping never loses data.
    assert session.scalar(select(func.count()).select_from(Match)) == 2
    assert len(client.sent) == 1

    deliveries = list(session.scalars(select(Delivery).order_by(Delivery.match_id)))
    assert [d.status for d in deliveries] == ["sent", GROUPED_DELIVERY_STATUS]
    assert deliveries[1].delivered_at is None


async def test_different_price_in_the_same_window_never_groups(session: Session) -> None:
    source_a, source_b, rule, recipient = _seed_two_sources(session)
    client = FakeBotClient()
    notifier = BotNotifier(bot_token="token", client=client, allowlisted_chat_ids={"999"})
    dedupe_cache = DedupeCache()

    await process_message(
        session,
        _msg(source_a.id, text="RTX 5070 por R$ 4000 na Amazon", minutes_offset=0, message_id=1),
        rule,
        [recipient],
        notifier,
        dedupe_cache,
    )
    session.commit()

    await process_message(
        session,
        _msg(
            source_b.id,
            text="RTX 5070 por R$ 4200 no Mercado Livre",
            minutes_offset=5,
            message_id=2,
        ),
        rule,
        [recipient],
        notifier,
        dedupe_cache,
    )
    session.commit()

    # Different price entirely — a real, second alert, never grouped.
    assert len(client.sent) == 2
    statuses = {d.status for d in session.scalars(select(Delivery))}
    assert statuses == {"sent"}


async def test_outside_the_window_never_groups(session: Session) -> None:
    source_a, source_b, rule, recipient = _seed_two_sources(session)
    client = FakeBotClient()
    notifier = BotNotifier(bot_token="token", client=client, allowlisted_chat_ids={"999"})
    dedupe_cache = DedupeCache()
    past_window_minutes = (GROUPING_WINDOW + timedelta(minutes=1)).total_seconds() / 60

    await process_message(
        session,
        _msg(source_a.id, text="RTX 5070 por R$ 4000 na Amazon", minutes_offset=0, message_id=1),
        rule,
        [recipient],
        notifier,
        dedupe_cache,
    )
    session.commit()

    await process_message(
        session,
        _msg(
            source_b.id,
            text="RTX 5070 por R$ 4000 no Mercado Livre",
            minutes_offset=past_window_minutes,
            message_id=2,
        ),
        rule,
        [recipient],
        notifier,
        dedupe_cache,
    )
    session.commit()

    # Same rule and price, but far enough apart to be a genuinely separate
    # occurrence — two real alerts.
    assert len(client.sent) == 2
    statuses = {d.status for d in session.scalars(select(Delivery))}
    assert statuses == {"sent"}


async def test_a_match_with_no_extractable_price_is_never_grouped(session: Session) -> None:
    """Both required fields (rule_id and price_cents) must be non-null — a
    priceless match can never be the anchor or the follower of a group.
    """
    source_a, source_b, rule, recipient = _seed_two_sources(session)
    client = FakeBotClient()
    notifier = BotNotifier(bot_token="token", client=client, allowlisted_chat_ids={"999"})
    dedupe_cache = DedupeCache()

    await process_message(
        session,
        _msg(source_a.id, text="RTX 5070 chegou, sem preço ainda", minutes_offset=0, message_id=1),
        rule,
        [recipient],
        notifier,
        dedupe_cache,
    )
    session.commit()

    await process_message(
        session,
        _msg(source_b.id, text="RTX 5070 também sem preço", minutes_offset=1, message_id=2),
        rule,
        [recipient],
        notifier,
        dedupe_cache,
    )
    session.commit()

    assert len(client.sent) == 2
    statuses = {d.status for d in session.scalars(select(Delivery))}
    assert statuses == {"sent"}
