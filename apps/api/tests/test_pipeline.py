from dataclasses import dataclass
from datetime import UTC, datetime

import pytest
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.pipeline import (
    IncomingMessage,
    build_match_event,
    compute_group_key,
    process_message,
    publish_match_event,
)
from models import Delivery, Match, Recipient, Rule, Source
from packages.events.broker import EventBroker
from packages.metrics.counters import MetricReason, get_count
from packages.notifications.bot import BotNotifier
from packages.notifications.fakes import FakeBotClient
from packages.rules.dedupe import DedupeCache


def _seed(session: Session, *, rule: Rule | None = None) -> tuple[Source, Rule, Recipient]:
    source = Source(name="Grupo Teste", telegram_chat_id="-100123")
    rule = rule or Rule(name="iPhone", include_terms="iphone", max_price_cents=500000)
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


# --- matriz: cada linha é um caso de mensagem -> resultado esperado -----------


@dataclass
class MatrixCase:
    label: str
    rule: Rule
    message_text: str
    expect_match: bool
    expect_reason: str | None
    expect_metric: MetricReason


MATRIX = [
    MatrixCase(
        label="verdadeiro_positivo",
        rule=Rule(name="iPhone", include_terms="iphone", max_price_cents=500000),
        message_text="Promoção iPhone 15 por R$ 3.899",
        expect_match=True,
        expect_reason=None,
        expect_metric=MetricReason.SEEN,
    ),
    MatrixCase(
        label="falso_positivo_evitado_por_bloqueio",
        rule=Rule(name="iPhone sem usado", include_terms="iphone", exclude_terms="usado"),
        message_text="iPhone usado, aceito troca",
        expect_match=False,
        expect_reason=MetricReason.BLOCKED.value,
        expect_metric=MetricReason.BLOCKED,
    ),
    MatrixCase(
        label="preco_acima_do_teto",
        rule=Rule(name="iPhone", include_terms="iphone", max_price_cents=500000),
        message_text="iPhone 15 por R$ 9.999",
        expect_match=False,
        expect_reason=MetricReason.PRICE_ABOVE_CEILING.value,
        expect_metric=MetricReason.PRICE_ABOVE_CEILING,
    ),
    MatrixCase(
        label="sem_termo_correspondente",
        rule=Rule(name="iPhone", include_terms="iphone"),
        message_text="Samsung Galaxy em promoção",
        expect_match=False,
        expect_reason=MetricReason.NO_TERM.value,
        expect_metric=MetricReason.NO_TERM,
    ),
]


@pytest.mark.parametrize("case", MATRIX, ids=[c.label for c in MATRIX])
async def test_pipeline_matrix(session: Session, case: MatrixCase) -> None:
    source, rule, recipient = _seed(session, rule=case.rule)
    client = FakeBotClient()
    notifier = BotNotifier(bot_token="token", client=client, allowlisted_chat_ids={"999"})
    dedupe_cache = DedupeCache()

    result = await process_message(
        session, _message(source, case.message_text), rule, [recipient], notifier, dedupe_cache
    )
    session.commit()

    assert (result.match is not None) is case.expect_match
    assert result.reason == case.expect_reason
    assert get_count(session, case.expect_metric, source_id=source.id) == 1
    expected_match_count = 1 if case.expect_match else 0
    assert session.scalar(select(func.count()).select_from(Match)) == expected_match_count
    if case.expect_match:
        assert client.sent == [("999", case.message_text)]
    else:
        assert client.sent == []


# --- matriz: falha simulada de entrega (setup próprio, dois destinatários) ----


async def test_delivery_failure_is_recorded_without_failing_the_whole_batch(
    session: Session,
) -> None:
    source, rule, _ = _seed(session)
    ok_recipient = Recipient(name="Gabriel", telegram_chat_id="222", allowlisted=True)
    failing_recipient = Recipient(name="Namorada", telegram_chat_id="111", allowlisted=True)
    session.add_all([ok_recipient, failing_recipient])
    session.flush()

    client = FakeBotClient(fail_for_chat_ids={"111"})
    notifier = BotNotifier(bot_token="token", client=client, allowlisted_chat_ids={"222", "111"})
    dedupe_cache = DedupeCache()

    result = await process_message(
        session,
        _message(source, "Promoção iPhone 15 por R$ 3.899"),
        rule,
        [ok_recipient, failing_recipient],
        notifier,
        dedupe_cache,
    )
    session.commit()

    assert result.match is not None
    assert result.deliveries_sent == 1
    assert client.sent == [("222", "Promoção iPhone 15 por R$ 3.899")]
    assert get_count(session, MetricReason.DELIVERY_FAILURE, source_id=source.id) == 1
    assert session.scalar(select(func.count()).select_from(Delivery)) == 2


# --- não-duplicação ao reprocessar a mesma mensagem ---------------------------


async def test_reprocessing_same_message_does_not_duplicate_match_or_delivery(
    session: Session,
) -> None:
    source, rule, recipient = _seed(session)
    client = FakeBotClient()
    notifier = BotNotifier(bot_token="token", client=client, allowlisted_chat_ids={"999"})
    dedupe_cache = DedupeCache()
    message = _message(source, "Promoção iPhone 15 por R$ 3.899")

    first = await process_message(session, message, rule, [recipient], notifier, dedupe_cache)
    second = await process_message(session, message, rule, [recipient], notifier, dedupe_cache)
    session.commit()

    assert first.match is not None
    assert second.match is None
    assert second.reason == "duplicate"
    assert session.scalar(select(func.count()).select_from(Match)) == 1
    assert session.scalar(select(func.count()).select_from(Delivery)) == 1
    assert client.sent == [("999", "Promoção iPhone 15 por R$ 3.899")]


# --- publicação de evento SSE só depois do commit -----------------------------


async def test_publish_match_event_is_only_meant_to_run_after_commit(
    session: Session,
) -> None:
    source, rule, recipient = _seed(session)
    client = FakeBotClient()
    notifier = BotNotifier(bot_token="token", client=client, allowlisted_chat_ids={"999"})
    dedupe_cache = DedupeCache()

    result = await process_message(
        session,
        _message(source, "Promoção iPhone 15 por R$ 3.899"),
        rule,
        [recipient],
        notifier,
        dedupe_cache,
    )
    session.commit()

    broker = EventBroker()
    publish_match_event(broker, result)

    # last_event_id=0 replays everything published so far, since a fresh subscribe
    # with no Last-Event-ID (a new client, not a reconnect) never gets a backlog.
    subscription = broker.subscribe(last_event_id=0)
    assert len(subscription.backlog) == 1
    event = subscription.backlog[0]
    assert event.type == "match"
    assert result.match is not None
    matched_at = event.data["matched_at"]
    assert isinstance(matched_at, str)
    assert matched_at.endswith("Z"), "a bare timestamp is read by the browser as local time"
    assert datetime.fromisoformat(matched_at) == result.match.matched_at.replace(tzinfo=UTC)
    assert event.data == {
        "match_id": result.match.id,
        "source_id": source.id,
        "rule_id": rule.id,
        "price_cents": result.match.price_cents,
        "product_key": "15-iphone",
        "message_link": None,
        "matched_at": matched_at,
        "deliveries_sent": 1,
        "target_hit": False,
        # S14-05 (F5): a hint for the live UI to fold this event into an
        # existing feed card — `publish_match_event` was called without a
        # session here (same as every pre-S14-05 caller), so there is no
        # `grouped_summary` to compute.
        "group_key": compute_group_key(
            result.match.product_key, result.match.price_cents, result.match.matched_at
        ),
        "grouped_summary": None,
    }
    # S14-01: computed on insert from the message text, not left for a backfill.
    # S14-01 recalibration: canonical order is model-code tokens then
    # variant/line words, so "iPhone 15" (no recognised brand) becomes
    # "15-iphone" rather than the original word order.
    assert result.match.product_key == "15-iphone"


async def test_publish_match_event_is_a_no_op_when_the_message_was_discarded(
    session: Session,
) -> None:
    source, rule, recipient = _seed(session)
    client = FakeBotClient()
    notifier = BotNotifier(bot_token="token", client=client, allowlisted_chat_ids={"999"})
    dedupe_cache = DedupeCache()

    result = await process_message(
        session,
        _message(source, "Samsung Galaxy em promoção"),
        rule,
        [recipient],
        notifier,
        dedupe_cache,
    )
    session.commit()

    assert build_match_event(result) is None

    broker = EventBroker()
    publish_match_event(broker, result)
    subscription = broker.subscribe(last_event_id=None)
    assert subscription.backlog == []
