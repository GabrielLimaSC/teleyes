"""S14-02 (F6) — price target per rule + prioritized delivery.

Mirrors the seeding/assertion style of `test_pipeline.py` and
`test_pipeline_grouping.py`: real `process_message` calls against an
in-memory-backed `session` fixture (real Alembic schema), a `FakeBotClient`
recording every text actually sent, and `Delivery` rows read back to check
`kind`/`status`.
"""

from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.pipeline import (
    DELIVERY_KIND_IMMEDIATE,
    DELIVERY_KIND_TARGET,
    GROUPED_DELIVERY_STATUS,
    IncomingMessage,
    decide_delivery_kind,
    process_message,
)
from models import Delivery, Match, Recipient, Rule, Source
from packages.notifications.bot import BotNotifier
from packages.notifications.fakes import FakeBotClient
from packages.rules.dedupe import DedupeCache


def _seed(session: Session, *, target_price_cents: int | None) -> tuple[Source, Rule, Recipient]:
    source = Source(name="Grupo Teste", telegram_chat_id="-100123")
    rule = Rule(name="RTX 5070", include_terms="rtx 5070", target_price_cents=target_price_cents)
    recipient = Recipient(name="Gabriel", telegram_chat_id="999", allowlisted=True)
    session.add_all([source, rule, recipient])
    session.flush()
    return source, rule, recipient


def _message(source: Source, text: str, message_id: int = 1) -> IncomingMessage:
    return IncomingMessage(
        source_id=source.id,
        message_id=message_id,
        text=text,
        link=None,
        received_at=datetime.now(UTC),
    )


def _deliveries_for(session: Session, match_id: int) -> list[Delivery]:
    return list(session.scalars(select(Delivery).where(Delivery.match_id == match_id)))


# --- decide_delivery_kind: the single decision point ---------------------


def test_decide_delivery_kind_picks_target_when_price_reaches_it() -> None:
    rule = Rule(name="R", include_terms="x", target_price_cents=205_000)
    assert decide_delivery_kind(rule, 200_000) == DELIVERY_KIND_TARGET
    assert decide_delivery_kind(rule, 205_000) == DELIVERY_KIND_TARGET


def test_decide_delivery_kind_picks_immediate_above_target_or_without_one() -> None:
    with_target = Rule(name="R", include_terms="x", target_price_cents=205_000)
    without_target = Rule(name="R", include_terms="x")
    assert decide_delivery_kind(with_target, 224_900) == DELIVERY_KIND_IMMEDIATE
    assert decide_delivery_kind(without_target, 100) == DELIVERY_KIND_IMMEDIATE
    assert decide_delivery_kind(with_target, None) == DELIVERY_KIND_IMMEDIATE


# --- pipeline behavior -----------------------------------------------------


async def test_target_hit_sends_a_prioritized_message(session: Session) -> None:
    source, rule, recipient = _seed(session, target_price_cents=205_000)
    client = FakeBotClient()
    notifier = BotNotifier(bot_token="token", client=client, allowlisted_chat_ids={"999"})
    dedupe_cache = DedupeCache()

    result = await process_message(
        session,
        _message(source, "RTX 5070 por R$ 2.000 na Amazon"),
        rule,
        [recipient],
        notifier,
        dedupe_cache,
    )
    session.commit()

    assert result.match is not None
    assert result.target_hit is True
    assert result.deliveries_sent == 1
    assert len(client.sent) == 1
    chat_id, text = client.sent[0]
    assert chat_id == "999"
    assert text.startswith("🎯 Alvo atingido!")
    assert "R$ 2.050,00" in text  # the target
    assert "R$ 2.000,00" in text  # the actual price
    assert "RTX 5070 por R$ 2.000 na Amazon" in text  # original message preserved

    deliveries = _deliveries_for(session, result.match.id)
    assert len(deliveries) == 1
    assert deliveries[0].kind == DELIVERY_KIND_TARGET
    assert deliveries[0].status == "sent"


async def test_price_above_target_follows_the_normal_flow(session: Session) -> None:
    source, rule, recipient = _seed(session, target_price_cents=205_000)
    client = FakeBotClient()
    notifier = BotNotifier(bot_token="token", client=client, allowlisted_chat_ids={"999"})
    dedupe_cache = DedupeCache()

    result = await process_message(
        session,
        _message(source, "RTX 5070 por R$ 2.249 na Amazon"),
        rule,
        [recipient],
        notifier,
        dedupe_cache,
    )
    session.commit()

    assert result.target_hit is False
    assert result.match is not None
    assert client.sent == [("999", "RTX 5070 por R$ 2.249 na Amazon")]

    deliveries = _deliveries_for(session, result.match.id)
    assert len(deliveries) == 1
    assert deliveries[0].kind == DELIVERY_KIND_IMMEDIATE
    assert deliveries[0].status == "sent"


async def test_no_target_set_changes_nothing(session: Session) -> None:
    source, rule, recipient = _seed(session, target_price_cents=None)
    client = FakeBotClient()
    notifier = BotNotifier(bot_token="token", client=client, allowlisted_chat_ids={"999"})
    dedupe_cache = DedupeCache()

    result = await process_message(
        session,
        _message(source, "RTX 5070 por R$ 1.000 na Amazon"),
        rule,
        [recipient],
        notifier,
        dedupe_cache,
    )
    session.commit()

    assert result.target_hit is False
    assert result.match is not None
    assert client.sent == [("999", "RTX 5070 por R$ 1.000 na Amazon")]
    deliveries = _deliveries_for(session, result.match.id)
    assert deliveries[0].kind == DELIVERY_KIND_IMMEDIATE


async def test_reprocessing_the_same_real_message_never_duplicates_the_target_delivery(
    session: Session,
) -> None:
    """S14-02 done_when: a restart/reprocess of a message with a real
    Telegram identity is a no-op (`_persist_match`'s own S6-01 identity
    check) — the target delivery it already sent must not fire again.
    """
    source, rule, recipient = _seed(session, target_price_cents=205_000)
    client = FakeBotClient()
    notifier = BotNotifier(bot_token="token", client=client, allowlisted_chat_ids={"999"})
    dedupe_cache = DedupeCache()
    message = _message(source, "RTX 5070 por R$ 2.000 na Amazon", message_id=42)

    first = await process_message(session, message, rule, [recipient], notifier, dedupe_cache)
    session.commit()
    assert first.target_hit is True
    assert first.match is not None

    # Simulate a restart: a fresh notifier and dedupe cache, same real message.
    restarted_notifier = BotNotifier(
        bot_token="token", client=client, allowlisted_chat_ids={"999"}
    )
    second = await process_message(
        session, message, rule, [recipient], restarted_notifier, DedupeCache()
    )
    session.commit()

    assert second.match is None
    assert second.reason == "duplicate"
    assert len(client.sent) == 1
    assert session.scalar(select(func.count()).select_from(Match)) == 1
    assert session.scalar(select(func.count()).select_from(Delivery)) == 1


async def test_match_that_hits_target_after_a_grouped_common_match_is_delivered_once_as_target(
    session: Session,
) -> None:
    """S14-02: the plain channel would suppress a repeat of an
    already-notified promotion (S7-11) — but a match that reaches its rule's
    target must still be delivered, even though an earlier *common* match of
    the same group already sent a real alert.
    """
    source_a, rule, recipient = _seed(session, target_price_cents=None)
    source_b = Source(name="Outro Grupo", telegram_chat_id="-100999")
    session.add(source_b)
    session.commit()

    client = FakeBotClient()
    notifier = BotNotifier(bot_token="token", client=client, allowlisted_chat_ids={"999"})
    dedupe_cache = DedupeCache()

    first = await process_message(
        session,
        _message(source_a, "RTX 5070 por R$ 2.000 na Amazon", message_id=1),
        rule,
        [recipient],
        notifier,
        dedupe_cache,
    )
    session.commit()
    assert first.target_hit is False
    assert client.sent == [("999", "RTX 5070 por R$ 2.000 na Amazon")]

    # Gabriel sets a target the exact same price already reaches, between
    # the two postings.
    rule.target_price_cents = 200_000
    session.commit()

    second_message = IncomingMessage(
        source_id=source_b.id,
        message_id=2,
        text="RTX 5070 por R$ 2.000 no Mercado Livre",
        link=None,
        received_at=datetime.now(UTC) + timedelta(minutes=5),
    )
    second = await process_message(
        session, second_message, rule, [recipient], notifier, dedupe_cache
    )
    session.commit()

    assert second.match is not None
    assert second.target_hit is True
    assert second.deliveries_sent == 1
    assert len(client.sent) == 2
    assert client.sent[1][1].startswith("🎯 Alvo atingido!")

    deliveries = _deliveries_for(session, second.match.id)
    by_kind = {delivery.kind: delivery.status for delivery in deliveries}
    assert by_kind == {
        DELIVERY_KIND_IMMEDIATE: GROUPED_DELIVERY_STATUS,
        DELIVERY_KIND_TARGET: "sent",
    }

    # Reprocessing (restart) never adds a third delivery for this match.
    restarted_notifier = BotNotifier(
        bot_token="token", client=client, allowlisted_chat_ids={"999"}
    )
    third = await process_message(
        session, second_message, rule, [recipient], restarted_notifier, DedupeCache()
    )
    session.commit()
    assert third.match is None
    assert len(_deliveries_for(session, second.match.id)) == 2
