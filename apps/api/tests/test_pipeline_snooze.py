"""S14-03 (F3): silencing only ever suppresses the `Delivery` — the match is
still persisted and the SSE event still fires exactly as if nothing were
snoozed. Every case uses `IncomingMessage.received_at` as the injected
clock, same as every other pipeline test.
"""

from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.pipeline import IncomingMessage, ProcessResult, build_match_event, process_message
from models import Delivery, Match, Recipient, Rule, Snooze, Source
from packages.notifications.bot import BotNotifier
from packages.notifications.fakes import FakeBotClient
from packages.rules.dedupe import DedupeCache

PALIT = "Placa de Vídeo Palit RTX 5070 Ti 16GB\n\nR$ 5.749,00 no pix\nhttps://x.example/1"
NOW = datetime(2026, 9, 23, 12, 0, tzinfo=UTC)


def _seed(session: Session) -> tuple[Source, Rule, Recipient]:
    source = Source(name="Grupo Teste", telegram_chat_id="-100123")
    rule = Rule(name="Palit RTX", include_terms="rtx")
    recipient = Recipient(name="Gabriel", telegram_chat_id="999", allowlisted=True)
    session.add_all([source, rule, recipient])
    session.commit()
    return source, rule, recipient


def _message(source: Source, *, text: str = PALIT, message_id: int = 1) -> IncomingMessage:
    return IncomingMessage(
        source_id=source.id, message_id=message_id, text=text, link=None, received_at=NOW
    )


async def _run(
    session: Session,
    source: Source,
    rule: Rule,
    recipient: Recipient,
    *,
    text: str = PALIT,
    message_id: int = 1,
) -> ProcessResult:
    client = FakeBotClient()
    notifier = BotNotifier(bot_token="token", client=client, allowlisted_chat_ids={"999"})
    message = _message(source, text=text, message_id=message_id)
    return await process_message(session, message, rule, [recipient], notifier, DedupeCache())


async def test_a_match_snoozed_by_rule_is_persisted_and_published_without_a_delivery(
    session: Session,
) -> None:
    source, rule, recipient = _seed(session)
    session.add(Snooze(scope="rule", rule_id=rule.id, until=NOW + timedelta(days=1)))
    session.commit()

    result = await _run(session, source, rule, recipient)
    session.commit()

    assert result.match is not None
    assert result.deliveries_sent == 0
    assert result.reason == "snoozed"
    stored = session.scalar(select(Match).where(Match.id == result.match.id))
    assert stored is not None
    assert stored.message_text == PALIT
    assert session.scalar(select(Delivery).where(Delivery.match_id == result.match.id)) is None
    # SSE still fires: `build_match_event` only checks `result.match`.
    event = build_match_event(result)
    assert event is not None
    assert event["deliveries_sent"] == 0


async def test_a_match_snoozed_by_product_is_persisted_and_published_without_a_delivery(
    session: Session,
) -> None:
    source, rule, recipient = _seed(session)
    session.add(
        Snooze(scope="product", product_key="palit-rtx-5070-ti", until=NOW + timedelta(days=1))
    )
    session.commit()

    result = await _run(session, source, rule, recipient)
    session.commit()

    assert result.match is not None
    assert result.match.product_key == "palit-rtx-5070-ti"
    assert result.deliveries_sent == 0
    assert session.scalar(select(Delivery).where(Delivery.match_id == result.match.id)) is None


async def test_an_expired_snooze_still_delivers(session: Session) -> None:
    source, rule, recipient = _seed(session)
    session.add(Snooze(scope="rule", rule_id=rule.id, until=NOW - timedelta(minutes=1)))
    session.commit()

    result = await _run(session, source, rule, recipient)
    session.commit()

    assert result.deliveries_sent == 1
    assert result.match is not None
    delivery = session.scalar(select(Delivery).where(Delivery.match_id == result.match.id))
    assert delivery is not None
    assert delivery.status == "sent"


async def test_a_snooze_of_another_rule_or_product_does_not_suppress_delivery(
    session: Session,
) -> None:
    source, rule, recipient = _seed(session)
    other_rule = Rule(name="Notebook", include_terms="notebook")
    session.add(other_rule)
    session.flush()
    session.add_all(
        [
            Snooze(scope="rule", rule_id=other_rule.id, until=NOW + timedelta(days=1)),
            Snooze(scope="product", product_key="outro-produto", until=NOW + timedelta(days=1)),
        ]
    )
    session.commit()

    result = await _run(session, source, rule, recipient)
    session.commit()

    assert result.deliveries_sent == 1


async def test_reactivating_deletes_the_snooze_and_the_next_match_delivers(
    session: Session,
) -> None:
    source, rule, recipient = _seed(session)
    snooze = Snooze(scope="rule", rule_id=rule.id, until=NOW + timedelta(days=1))
    session.add(snooze)
    session.commit()

    first = await _run(session, source, rule, recipient, message_id=1)
    session.commit()
    assert first.deliveries_sent == 0

    # "Reativar": delete the snooze row (the API's DELETE /snoozes/{id}).
    session.delete(session.get(Snooze, snooze.id))
    session.commit()

    second = await _run(session, source, rule, recipient, message_id=2)
    session.commit()
    assert second.deliveries_sent == 1


# --- S14-02: a target hit pierces an active snooze (Gabriel, 2026-09-23) ----


async def test_a_target_hit_still_delivers_through_an_active_rule_snooze(
    session: Session,
) -> None:
    source, rule, recipient = _seed(session)
    rule.target_price_cents = 574_900  # PALIT's own price: an exact hit.
    session.add(Snooze(scope="rule", rule_id=rule.id, until=NOW + timedelta(days=1)))
    session.commit()

    result = await _run(session, source, rule, recipient)
    session.commit()

    assert result.target_hit is True
    assert result.deliveries_sent == 1
    assert result.match is not None
    delivery = session.scalar(select(Delivery).where(Delivery.match_id == result.match.id))
    assert delivery is not None
    assert delivery.kind == "target"
    assert delivery.status == "sent"


async def test_a_price_above_target_stays_snoozed(session: Session) -> None:
    source, rule, recipient = _seed(session)
    rule.target_price_cents = 500_000  # PALIT's R$ 5.749,00 is above this.
    session.add(Snooze(scope="rule", rule_id=rule.id, until=NOW + timedelta(days=1)))
    session.commit()

    result = await _run(session, source, rule, recipient)
    session.commit()

    assert result.target_hit is False
    assert result.deliveries_sent == 0
    assert result.reason == "snoozed"
    assert result.match is not None
    assert session.scalar(select(Delivery).where(Delivery.match_id == result.match.id)) is None
