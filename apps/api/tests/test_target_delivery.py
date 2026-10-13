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
    GROUPING_WINDOW,
    IncomingMessage,
    decide_delivery_kind,
    process_message,
)
from models import Delivery, Match, Recipient, Rule, Snooze, Source
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


# --- Tech Lead fix (revisão bloqueada): a target hit alerts once per group -
# (same rule, same price, within GROUPING_WINDOW) — before this fix, the same
# real-world promotion posted in N groups pinged Gabriel N times.


async def test_three_postings_below_target_in_the_same_window_send_exactly_one_target_alert(
    session: Session,
) -> None:
    source_a, rule, recipient = _seed(session, target_price_cents=200_000)
    source_b = Source(name="Grupo B", telegram_chat_id="-100222")
    source_c = Source(name="Grupo C", telegram_chat_id="-100333")
    session.add_all([source_b, source_c])
    session.commit()

    client = FakeBotClient()
    notifier = BotNotifier(bot_token="token", client=client, allowlisted_chat_ids={"999"})
    dedupe_cache = DedupeCache()
    base = datetime.now(UTC)

    results = []
    for index, source in enumerate((source_a, source_b, source_c)):
        message = IncomingMessage(
            source_id=source.id,
            message_id=1,
            text=f"RTX 5070 por R$ 2.000 na loja {index}",
            link=None,
            received_at=base + timedelta(minutes=index * 2),
        )
        result = await process_message(
            session, message, rule, [recipient], notifier, dedupe_cache
        )
        session.commit()
        results.append(result)

    assert [result.target_hit for result in results] == [True, True, True]
    assert [result.deliveries_sent for result in results] == [1, 0, 0]
    assert len(client.sent) == 1
    assert client.sent[0][1].startswith("🎯 Alvo atingido!")

    for result in results[1:]:
        assert result.match is not None
        deliveries = _deliveries_for(session, result.match.id)
        assert len(deliveries) == 1
        assert deliveries[0].kind == DELIVERY_KIND_TARGET
        assert deliveries[0].status == GROUPED_DELIVERY_STATUS


async def test_repetition_after_an_already_notified_common_match_still_sends_only_one_target(
    session: Session,
) -> None:
    """Mirrors `test_match_that_hits_target_after_a_grouped_common_match_is_
    delivered_once_as_target` above, but with a further repetition below the
    target — the first target hit must still be the only real target send.
    """
    source_a, rule, recipient = _seed(session, target_price_cents=None)
    source_b = Source(name="Outro Grupo", telegram_chat_id="-100999")
    source_c = Source(name="Terceiro Grupo", telegram_chat_id="-100998")
    session.add_all([source_b, source_c])
    session.commit()

    client = FakeBotClient()
    notifier = BotNotifier(bot_token="token", client=client, allowlisted_chat_ids={"999"})
    dedupe_cache = DedupeCache()
    base = datetime.now(UTC)

    first = await process_message(
        session,
        IncomingMessage(
            source_id=source_a.id,
            message_id=1,
            text="RTX 5070 por R$ 2.000 na Amazon",
            link=None,
            received_at=base,
        ),
        rule,
        [recipient],
        notifier,
        dedupe_cache,
    )
    session.commit()
    assert first.target_hit is False
    assert client.sent == [("999", "RTX 5070 por R$ 2.000 na Amazon")]

    rule.target_price_cents = 200_000
    session.commit()

    second = await process_message(
        session,
        IncomingMessage(
            source_id=source_b.id,
            message_id=1,
            text="RTX 5070 por R$ 2.000 no Mercado Livre",
            link=None,
            received_at=base + timedelta(minutes=5),
        ),
        rule,
        [recipient],
        notifier,
        dedupe_cache,
    )
    session.commit()
    assert second.target_hit is True
    assert second.deliveries_sent == 1

    third = await process_message(
        session,
        IncomingMessage(
            source_id=source_c.id,
            message_id=1,
            text="RTX 5070 por R$ 2.000 no Magalu",
            link=None,
            received_at=base + timedelta(minutes=9),
        ),
        rule,
        [recipient],
        notifier,
        dedupe_cache,
    )
    session.commit()
    assert third.target_hit is True
    assert third.deliveries_sent == 0

    assert len(client.sent) == 2  # the plain alert + exactly one target alert
    assert client.sent[1][1].startswith("🎯 Alvo atingido!")

    assert third.match is not None
    deliveries = _deliveries_for(session, third.match.id)
    assert len(deliveries) == 1
    assert deliveries[0].kind == DELIVERY_KIND_TARGET
    assert deliveries[0].status == GROUPED_DELIVERY_STATUS


async def test_repetition_outside_the_grouping_window_sends_a_new_target_alert(
    session: Session,
) -> None:
    source_a, rule, recipient = _seed(session, target_price_cents=200_000)
    source_b = Source(name="Outro Grupo", telegram_chat_id="-100777")
    session.add(source_b)
    session.commit()

    client = FakeBotClient()
    notifier = BotNotifier(bot_token="token", client=client, allowlisted_chat_ids={"999"})
    dedupe_cache = DedupeCache()
    base = datetime.now(UTC)

    first = await process_message(
        session,
        IncomingMessage(
            source_id=source_a.id,
            message_id=1,
            text="RTX 5070 por R$ 2.000 na Amazon",
            link=None,
            received_at=base,
        ),
        rule,
        [recipient],
        notifier,
        dedupe_cache,
    )
    session.commit()
    assert first.deliveries_sent == 1

    second = await process_message(
        session,
        IncomingMessage(
            source_id=source_b.id,
            message_id=1,
            text="RTX 5070 por R$ 2.000 no Mercado Livre",
            link=None,
            received_at=base + GROUPING_WINDOW + timedelta(minutes=1),
        ),
        rule,
        [recipient],
        notifier,
        dedupe_cache,
    )
    session.commit()
    assert second.target_hit is True
    assert second.deliveries_sent == 1

    assert len(client.sent) == 2
    assert all(text.startswith("🎯 Alvo atingido!") for _, text in client.sent)


async def test_snoozed_rule_still_sends_exactly_one_target_alert_for_a_repeated_group(
    session: Session,
) -> None:
    source_a, rule, recipient = _seed(session, target_price_cents=200_000)
    source_b = Source(name="Grupo B", telegram_chat_id="-100222")
    source_c = Source(name="Grupo C", telegram_chat_id="-100333")
    session.add_all([source_b, source_c])
    session.commit()

    base = datetime.now(UTC)
    session.add(Snooze(scope="rule", rule_id=rule.id, until=base + timedelta(days=1)))
    session.commit()

    client = FakeBotClient()
    notifier = BotNotifier(bot_token="token", client=client, allowlisted_chat_ids={"999"})
    dedupe_cache = DedupeCache()

    results = []
    for index, source in enumerate((source_a, source_b, source_c)):
        message = IncomingMessage(
            source_id=source.id,
            message_id=1,
            text=f"RTX 5070 por R$ 2.000 na loja {index}",
            link=None,
            received_at=base + timedelta(minutes=index * 2),
        )
        result = await process_message(
            session, message, rule, [recipient], notifier, dedupe_cache
        )
        session.commit()
        results.append(result)

    assert [result.target_hit for result in results] == [True, True, True]
    assert [result.deliveries_sent for result in results] == [1, 0, 0]
    assert len(client.sent) == 1
    assert client.sent[0][1].startswith("🎯 Alvo atingido!")


async def test_reprocessing_a_suppressed_group_repeat_target_delivery_never_duplicates(
    session: Session,
) -> None:
    source_a, rule, recipient = _seed(session, target_price_cents=200_000)
    source_b = Source(name="Grupo B", telegram_chat_id="-100222")
    session.add(source_b)
    session.commit()

    client = FakeBotClient()
    notifier = BotNotifier(bot_token="token", client=client, allowlisted_chat_ids={"999"})
    dedupe_cache = DedupeCache()
    base = datetime.now(UTC)

    first = await process_message(
        session,
        IncomingMessage(
            source_id=source_a.id,
            message_id=1,
            text="RTX 5070 por R$ 2.000 na Amazon",
            link=None,
            received_at=base,
        ),
        rule,
        [recipient],
        notifier,
        dedupe_cache,
    )
    session.commit()
    assert first.deliveries_sent == 1

    second_message = IncomingMessage(
        source_id=source_b.id,
        message_id=1,
        text="RTX 5070 por R$ 2.000 no Mercado Livre",
        link=None,
        received_at=base + timedelta(minutes=3),
    )
    second = await process_message(
        session, second_message, rule, [recipient], notifier, dedupe_cache
    )
    session.commit()
    assert second.deliveries_sent == 0
    assert second.match is not None
    assert len(_deliveries_for(session, second.match.id)) == 1

    restarted_notifier = BotNotifier(
        bot_token="token", client=client, allowlisted_chat_ids={"999"}
    )
    third = await process_message(
        session, second_message, rule, [recipient], restarted_notifier, DedupeCache()
    )
    session.commit()
    assert third.match is None
    assert third.reason == "duplicate"
    assert len(client.sent) == 1
    assert len(_deliveries_for(session, second.match.id)) == 1
