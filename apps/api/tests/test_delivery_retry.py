"""S17-01: failed alerts are logged, retried in place and resent later."""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from app.delivery_retry import resend_failed_deliveries
from app.pipeline import IncomingMessage, process_message_with_retry
from models import Delivery, Match, Recipient, Rule, Source
from models.db import get_engine, get_sessionmaker
from packages.notifications.bot import BotNotifier
from packages.rules.dedupe import DedupeCache

TEXT = "Promoção iPhone 15 por R$ 3.899"


class FlakyClient:
    """Fails the first `failures` sends with a network-like error, then works."""

    def __init__(self, failures: int) -> None:
        self.failures = failures
        self.calls = 0
        self.sent: list[tuple[str, str]] = []

    async def send_message(self, chat_id: str, text: str) -> None:
        self.calls += 1
        if self.calls <= self.failures:
            raise ConnectionError("simulated network down")
        self.sent.append((chat_id, text))


@pytest.fixture
def factory(session: Session, db_path: Path) -> sessionmaker[Session]:
    return get_sessionmaker(get_engine(f"sqlite:///{db_path}"))


def _seed(session: Session, rule: Rule | None = None) -> tuple[Source, Rule, Recipient]:
    source = Source(name="Grupo", telegram_chat_id="-100123")
    rule = rule or Rule(name="iPhone", include_terms="iphone", max_price_cents=500000)
    recipient = Recipient(name="Gabriel", telegram_chat_id="999", allowlisted=True)
    session.add_all([source, rule, recipient])
    session.commit()
    return source, rule, recipient


def _message(source: Source) -> IncomingMessage:
    return IncomingMessage(
        source_id=source.id,
        message_id=1,
        text=TEXT,
        link=None,
        received_at=datetime.now(UTC),
    )


def _notifier(client: FlakyClient) -> BotNotifier:
    return BotNotifier(bot_token="t", client=client, allowlisted_chat_ids={"999"})


async def _process(
    factory: sessionmaker[Session],
    source: Source,
    rule: Rule,
    recipient: Recipient,
    notifier: BotNotifier,
) -> None:
    await process_message_with_retry(
        factory, _message(source), rule, [recipient], notifier, DedupeCache()
    )


def _deliveries(session: Session) -> list[Delivery]:
    session.expire_all()
    return list(session.scalars(select(Delivery).order_by(Delivery.id)))


async def test_in_place_retry_sends_once_after_transient_failures(
    session: Session, factory: sessionmaker[Session]
) -> None:
    source, rule, recipient = _seed(session)
    client = FlakyClient(failures=2)

    await _process(factory, source, rule, recipient, _notifier(client))

    rows = _deliveries(session)
    assert [r.status for r in rows] == ["sent"]
    assert len(client.sent) == 1


async def test_failure_beyond_limit_stays_failed_and_logs_class_not_text(
    session: Session, factory: sessionmaker[Session], caplog: pytest.LogCaptureFixture
) -> None:
    source, rule, recipient = _seed(session)
    client = FlakyClient(failures=99)

    with caplog.at_level(logging.WARNING):
        await _process(factory, source, rule, recipient, _notifier(client))

    rows = _deliveries(session)
    assert [r.status for r in rows] == ["failed"]
    assert client.calls == 3
    match_id = session.scalars(select(Match.id)).one()
    line = next(r.getMessage() for r in caplog.records if "event=notify_failed" in r.getMessage())
    assert "error_class=ConnectionError" in line
    assert f"match_id={match_id}" in line
    assert "iPhone" not in caplog.text and "3.899" not in caplog.text


async def test_periodic_resend_updates_same_row_and_is_not_repeated(
    session: Session, factory: sessionmaker[Session]
) -> None:
    source, rule, recipient = _seed(session)
    client = FlakyClient(failures=3)  # all in-place attempts fail
    await _process(factory, source, rule, recipient, _notifier(client))
    failed_id = _deliveries(session)[0].id

    # New process after a restart: fresh notifier (empty in-memory dedupe).
    notifier = _notifier(client)
    assert await resend_failed_deliveries(factory, notifier) == 1
    rows = _deliveries(session)
    assert [(r.id, r.status) for r in rows] == [(failed_id, "sent")]
    assert rows[0].delivered_at is not None
    assert client.sent == [("999", TEXT)]

    # Another cycle, and another restart, must not send it again.
    assert await resend_failed_deliveries(factory, notifier) == 0
    assert await resend_failed_deliveries(factory, _notifier(client)) == 0
    assert len(client.sent) == 1


async def test_resend_keeps_failed_while_bot_is_still_down(
    session: Session, factory: sessionmaker[Session], caplog: pytest.LogCaptureFixture
) -> None:
    source, rule, recipient = _seed(session)
    client = FlakyClient(failures=99)
    await _process(factory, source, rule, recipient, _notifier(client))

    with caplog.at_level(logging.WARNING):
        assert await resend_failed_deliveries(factory, _notifier(client)) == 0

    assert [r.status for r in _deliveries(session)] == ["failed"]
    assert "error_class=ConnectionError" in caplog.text


async def test_old_failed_delivery_is_not_resent(
    session: Session, factory: sessionmaker[Session]
) -> None:
    source, rule, recipient = _seed(session)
    client = FlakyClient(failures=3)
    await _process(factory, source, rule, recipient, _notifier(client))
    row = _deliveries(session)[0]
    row.created_at = datetime.now(UTC) - timedelta(hours=7)
    session.commit()

    assert await resend_failed_deliveries(factory, _notifier(client)) == 0
    assert [r.status for r in _deliveries(session)] == ["failed"]
    assert client.sent == []


async def test_only_failed_rows_are_candidates(
    session: Session, factory: sessionmaker[Session]
) -> None:
    source, rule, recipient = _seed(session)
    await _process(factory, source, rule, recipient, _notifier(FlakyClient(failures=3)))
    row = _deliveries(session)[0]
    for status in ("sent", "historical", "grouped", "snoozed"):
        row.status = status
        session.commit()
        assert await resend_failed_deliveries(factory, _notifier(FlakyClient(0))) == 0
    # a digest-channel row is never resent either, even if it says failed
    row.status = "failed"
    row.kind = "digest"
    session.commit()
    assert await resend_failed_deliveries(factory, _notifier(FlakyClient(0))) == 0


async def test_target_alert_is_resent_with_target_text(
    session: Session, factory: sessionmaker[Session]
) -> None:
    rule = Rule(
        name="iPhone", include_terms="iphone", max_price_cents=500000, target_price_cents=400000
    )
    source, rule, recipient = _seed(session, rule)
    client = FlakyClient(failures=3)
    await _process(factory, source, rule, recipient, _notifier(client))
    assert _deliveries(session)[0].kind == "target"

    assert await resend_failed_deliveries(factory, _notifier(client)) == 1
    (chat_id, text) = client.sent[0]
    assert chat_id == "999"
    assert text.startswith("🎯 Alvo atingido!") and text.endswith(TEXT)


async def test_resend_respects_a_snooze_set_after_the_failure(
    session: Session, factory: sessionmaker[Session]
) -> None:
    from models import Snooze

    source, rule, recipient = _seed(session)
    client = FlakyClient(failures=3)
    await _process(factory, source, rule, recipient, _notifier(client))
    session.add(Snooze(scope="rule", rule_id=rule.id, until=datetime.now(UTC) + timedelta(hours=1)))
    session.commit()

    assert await resend_failed_deliveries(factory, _notifier(client)) == 0
    assert [r.status for r in _deliveries(session)] == ["failed"]
