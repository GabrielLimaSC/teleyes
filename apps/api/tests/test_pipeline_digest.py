"""S14-04 (F4) — pipeline wiring: a common match held back for the digest
instead of delivered immediately, gated on `digest_settings.enabled AND
mute_individual`. Mirrors `test_target_delivery.py`/`test_pipeline_snooze.py`:
real `process_message` calls against the `session` fixture's real schema.
"""

from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.digest_settings import save_digest_settings
from app.pipeline import (
    DELIVERY_KIND_DIGEST,
    DELIVERY_KIND_IMMEDIATE,
    DELIVERY_KIND_TARGET,
    GROUPED_DELIVERY_STATUS,
    IncomingMessage,
    process_message,
)
from models import Delivery, Recipient, Rule, Snooze, Source
from packages.notifications.bot import BotNotifier
from packages.notifications.fakes import FakeBotClient
from packages.rules.dedupe import DedupeCache

NOW = datetime(2026, 9, 24, 12, 0, tzinfo=UTC)


def _seed(
    session: Session, *, target_price_cents: int | None = None
) -> tuple[Source, Rule, Recipient]:
    source = Source(name="Grupo Teste", telegram_chat_id="-100123")
    rule = Rule(name="RTX 5070", include_terms="rtx 5070", target_price_cents=target_price_cents)
    recipient = Recipient(name="Gabriel", telegram_chat_id="999", allowlisted=True)
    session.add_all([source, rule, recipient])
    session.flush()
    return source, rule, recipient


def _message(
    source: Source,
    *,
    text: str = "RTX 5070 por R$ 2.000 na Amazon",
    message_id: int = 1,
    received_at: datetime = NOW,
) -> IncomingMessage:
    return IncomingMessage(
        source_id=source.id, message_id=message_id, text=text, link=None, received_at=received_at
    )


def _deliveries_for(session: Session, match_id: int) -> list[Delivery]:
    return list(session.scalars(select(Delivery).where(Delivery.match_id == match_id)))


def _enable_digest_with_muting(session: Session, *, mute_individual: bool = True) -> None:
    save_digest_settings(
        session, enabled=True, send_at_local="09:00", top_n=5, mute_individual=mute_individual
    )


async def test_digest_off_by_default_keeps_sending_immediately(session: Session) -> None:
    """No `digest_settings` row at all: `load_digest_settings` returns the
    disabled default, so a common match behaves exactly as before S14-04.
    """
    source, rule, recipient = _seed(session)
    client = FakeBotClient()
    notifier = BotNotifier(bot_token="token", client=client, allowlisted_chat_ids={"999"})

    result = await process_message(
        session, _message(source), rule, [recipient], notifier, DedupeCache()
    )
    session.commit()

    assert result.deliveries_sent == 1
    assert client.sent == [("999", "RTX 5070 por R$ 2.000 na Amazon")]
    assert result.match is not None
    deliveries = _deliveries_for(session, result.match.id)
    assert deliveries[0].kind == DELIVERY_KIND_IMMEDIATE
    assert deliveries[0].status == "sent"


async def test_digest_enabled_but_mute_individual_off_keeps_sending_immediately(
    session: Session,
) -> None:
    source, rule, recipient = _seed(session)
    _enable_digest_with_muting(session, mute_individual=False)
    client = FakeBotClient()
    notifier = BotNotifier(bot_token="token", client=client, allowlisted_chat_ids={"999"})

    result = await process_message(
        session, _message(source), rule, [recipient], notifier, DedupeCache()
    )
    session.commit()

    assert result.deliveries_sent == 1
    assert len(client.sent) == 1
    assert result.match is not None
    deliveries = _deliveries_for(session, result.match.id)
    assert deliveries[0].kind == DELIVERY_KIND_IMMEDIATE
    assert deliveries[0].status == "sent"


async def test_digest_enabled_and_mute_individual_on_queues_instead_of_sending(
    session: Session,
) -> None:
    source, rule, recipient = _seed(session)
    _enable_digest_with_muting(session)
    client = FakeBotClient()
    notifier = BotNotifier(bot_token="token", client=client, allowlisted_chat_ids={"999"})

    result = await process_message(
        session, _message(source), rule, [recipient], notifier, DedupeCache()
    )
    session.commit()

    assert result.deliveries_sent == 0
    assert client.sent == []  # nothing sent to Telegram right now
    assert result.match is not None
    deliveries = _deliveries_for(session, result.match.id)
    assert len(deliveries) == 1
    assert deliveries[0].kind == DELIVERY_KIND_DIGEST
    assert deliveries[0].status == "pending"
    assert deliveries[0].delivered_at is None


async def test_a_target_hit_still_sends_immediately_even_with_digest_muting_on(
    session: Session,
) -> None:
    source, rule, recipient = _seed(session, target_price_cents=205_000)
    _enable_digest_with_muting(session)
    client = FakeBotClient()
    notifier = BotNotifier(bot_token="token", client=client, allowlisted_chat_ids={"999"})

    result = await process_message(
        session, _message(source), rule, [recipient], notifier, DedupeCache()
    )
    session.commit()

    assert result.target_hit is True
    assert result.deliveries_sent == 1
    assert len(client.sent) == 1
    assert client.sent[0][1].startswith("🎯 Alvo atingido!")
    assert result.match is not None
    deliveries = _deliveries_for(session, result.match.id)
    assert deliveries[0].kind == DELIVERY_KIND_TARGET
    assert deliveries[0].status == "sent"


async def test_a_snoozed_common_match_never_reaches_the_digest_queue_either(
    session: Session,
) -> None:
    source, rule, recipient = _seed(session)
    _enable_digest_with_muting(session)
    session.add(Snooze(scope="rule", rule_id=rule.id, until=NOW + timedelta(days=1)))
    session.commit()
    client = FakeBotClient()
    notifier = BotNotifier(bot_token="token", client=client, allowlisted_chat_ids={"999"})

    result = await process_message(
        session, _message(source), rule, [recipient], notifier, DedupeCache()
    )
    session.commit()

    assert result.reason == "snoozed"
    assert result.deliveries_sent == 0
    assert client.sent == []
    assert result.match is not None
    # no delivery row at all — not even digest
    assert _deliveries_for(session, result.match.id) == []


async def test_a_repeat_within_the_grouping_window_stays_grouped_not_duplicated_in_the_digest(
    session: Session,
) -> None:
    source_a, rule, recipient = _seed(session)
    source_b = Source(name="Outro Grupo", telegram_chat_id="-100999")
    session.add(source_b)
    session.commit()
    _enable_digest_with_muting(session)

    client = FakeBotClient()
    notifier = BotNotifier(bot_token="token", client=client, allowlisted_chat_ids={"999"})
    dedupe_cache = DedupeCache()

    first = await process_message(
        session,
        _message(source_a, message_id=1, received_at=NOW),
        rule,
        [recipient],
        notifier,
        dedupe_cache,
    )
    session.commit()
    assert first.match is not None
    assert _deliveries_for(session, first.match.id)[0].status == "pending"

    second = await process_message(
        session,
        _message(
            source_b,
            text="RTX 5070 por R$ 2.000 no Mercado Livre",
            message_id=1,
            received_at=NOW + timedelta(minutes=5),
        ),
        rule,
        [recipient],
        notifier,
        dedupe_cache,
    )
    session.commit()

    assert second.match is not None
    deliveries = _deliveries_for(session, second.match.id)
    assert len(deliveries) == 1
    assert deliveries[0].kind == DELIVERY_KIND_DIGEST
    assert deliveries[0].status == GROUPED_DELIVERY_STATUS
    assert client.sent == []  # still nothing sent immediately, either match
