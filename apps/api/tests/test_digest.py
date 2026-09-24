"""S14-04 (F4): `app.digest` — queue ordering, text, the timezone-aware "next
run" computation, and `run_digest_once`'s idempotency/honesty.

Every clock value here is injected (`now=...`), same convention as every
other pipeline test (CLAUDE.md: relógio injetável em tudo o que for testado).
"""

from datetime import UTC, date, datetime, time, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.digest import (
    DigestQueueItem,
    build_digest_text,
    load_pending_queue,
    local_date_for,
    next_run_at,
    run_digest_once,
)
from app.pipeline import DELIVERY_KIND_DIGEST, DIGEST_SKIPPED_DELIVERY_STATUS
from models import Delivery, DigestRun, Match, Recipient, Rule, Source
from models.db import get_engine, get_sessionmaker
from packages.notifications.bot import BotNotifier
from packages.notifications.fakes import FakeBotClient

SP = ZoneInfo("America/Sao_Paulo")


def _seed(session: Session) -> tuple[Source, Rule, Recipient]:
    source = Source(name="Grupo Teste", telegram_chat_id="-100123")
    rule = Rule(name="RTX 5070", include_terms="rtx 5070")
    recipient = Recipient(name="Gabriel", telegram_chat_id="999", allowlisted=True)
    session.add_all([source, rule, recipient])
    session.flush()
    return source, rule, recipient


def _match(
    session: Session,
    source: Source,
    rule: Rule,
    *,
    message_id: int,
    price_cents: int | None,
    text: str = "RTX 5070 por R$ 2.000 na Amazon",
    link: str | None = "https://x.example/1",
    matched_at: datetime | None = None,
) -> Match:
    match = Match(
        source_id=source.id,
        rule_id=rule.id,
        telegram_message_id=message_id,
        message_text=text,
        price_cents=price_cents,
        message_link=link,
        matched_at=matched_at or datetime.now(UTC),
    )
    session.add(match)
    session.flush()
    return match


def _queue_delivery(
    session: Session, match: Match, recipient: Recipient, *, status: str = "pending"
) -> Delivery:
    delivery = Delivery(
        match_id=match.id,
        recipient_id=recipient.id,
        kind=DELIVERY_KIND_DIGEST,
        status=status,
    )
    session.add(delivery)
    session.flush()
    return delivery


# --- next_run_at -------------------------------------------------------------


def test_next_run_is_today_when_not_yet_run() -> None:
    now = datetime(2026, 9, 24, 10, 0, tzinfo=UTC)  # 07:00 in America/Sao_Paulo
    next_run = next_run_at(now_utc=now, tz=SP, send_at_local=time(9, 0), already_ran_today=False)

    assert next_run.astimezone(SP) == datetime(2026, 9, 24, 9, 0, tzinfo=SP)


def test_next_run_is_tomorrow_once_already_ran_today() -> None:
    now = datetime(2026, 9, 24, 10, 0, tzinfo=UTC)
    next_run = next_run_at(now_utc=now, tz=SP, send_at_local=time(9, 0), already_ran_today=True)

    assert next_run.astimezone(SP) == datetime(2026, 9, 25, 9, 0, tzinfo=SP)


def test_local_date_crosses_the_utc_day_boundary() -> None:
    """21:30 in São Paulo (UTC-3) on the 23rd is already 00:30 UTC on the
    24th — the local calendar day must follow the configured timezone, not
    the UTC date the instant happens to serialize as.
    """
    now_utc = datetime(2026, 9, 24, 0, 30, tzinfo=UTC)

    assert local_date_for(now_utc, SP) == date(2026, 9, 23)


# --- load_pending_queue / build_digest_text -----------------------------------


def test_queue_sorts_by_lowest_price_first_and_unpriced_last(session: Session) -> None:
    source, rule, recipient = _seed(session)
    cheap = _match(session, source, rule, message_id=1, price_cents=100_000)
    unpriced = _match(session, source, rule, message_id=2, price_cents=None)
    expensive = _match(session, source, rule, message_id=3, price_cents=300_000)
    for match in (cheap, unpriced, expensive):
        _queue_delivery(session, match, recipient)
    session.commit()

    queue = load_pending_queue(session)

    assert [item.match_id for item in queue] == [cheap.id, expensive.id, unpriced.id]


def test_queue_never_includes_a_grouped_or_already_sent_delivery(session: Session) -> None:
    source, rule, recipient = _seed(session)
    pending = _match(session, source, rule, message_id=1, price_cents=100_000)
    grouped = _match(session, source, rule, message_id=2, price_cents=100_000)
    already_sent = _match(session, source, rule, message_id=3, price_cents=100_000)
    _queue_delivery(session, pending, recipient, status="pending")
    _queue_delivery(session, grouped, recipient, status="grouped")
    _queue_delivery(session, already_sent, recipient, status="sent")
    session.commit()

    queue = load_pending_queue(session)

    assert [item.match_id for item in queue] == [pending.id]


def test_digest_text_is_pt_br_with_price_and_link() -> None:
    items = [
        DigestQueueItem(
            match_id=1,
            price_cents=224_900,
            title="Palit RTX 5070",
            message_link="https://x.example/1",
            matched_at=datetime.now(UTC),
        ),
        DigestQueueItem(
            match_id=2,
            price_cents=None,
            title="Produto sem preço",
            message_link=None,
            matched_at=datetime.now(UTC),
        ),
    ]

    text = build_digest_text(items)

    assert "2 oferta(s)" in text
    assert "R$ 2.249,00 — Palit RTX 5070 (https://x.example/1)" in text
    assert "preço não identificado — Produto sem preço" in text


# --- run_digest_once -----------------------------------------------------------


async def test_a_second_call_the_same_local_day_is_a_no_op(session: Session) -> None:
    now = datetime(2026, 9, 24, 12, 0, tzinfo=UTC)
    notifier = BotNotifier(bot_token="token", client=FakeBotClient(), allowlisted_chat_ids={"999"})

    first = await run_digest_once(session, notifier, now=now, tz=SP, top_n=5)
    second = await run_digest_once(session, notifier, now=now, tz=SP, top_n=5)

    assert first.ran is True
    assert second.ran is False
    assert session.query(DigestRun).count() == 1


async def test_an_empty_queue_still_records_the_run_without_sending(session: Session) -> None:
    now = datetime(2026, 9, 24, 12, 0, tzinfo=UTC)
    client = FakeBotClient()
    notifier = BotNotifier(bot_token="token", client=client, allowlisted_chat_ids={"999"})

    outcome = await run_digest_once(session, notifier, now=now, tz=SP, top_n=5)

    assert outcome.ran is True
    assert outcome.items_sent == 0
    assert outcome.sent is False
    assert client.sent == []
    run = session.get(DigestRun, local_date_for(now, SP))
    assert run is not None
    assert run.items_sent == 0
    assert run.items_skipped == 0


async def test_top_n_sends_the_cheapest_and_marks_the_overflow_skipped(session: Session) -> None:
    source, rule, recipient = _seed(session)
    matches = [
        _match(session, source, rule, message_id=index, price_cents=(index + 1) * 10_000)
        for index in range(4)
    ]
    for match in matches:
        _queue_delivery(session, match, recipient)
    session.commit()

    now = datetime(2026, 9, 24, 12, 0, tzinfo=UTC)
    client = FakeBotClient()
    notifier = BotNotifier(bot_token="token", client=client, allowlisted_chat_ids={"999"})

    outcome = await run_digest_once(session, notifier, now=now, tz=SP, top_n=2)

    assert outcome.items_sent == 2
    assert outcome.items_skipped == 2
    assert outcome.sent is True
    assert len(client.sent) == 1  # one recipient, one combined message

    all_deliveries = session.scalars(
        select(Delivery).where(Delivery.recipient_id == recipient.id)
    )
    deliveries = {delivery.match_id: delivery for delivery in all_deliveries}
    assert deliveries[matches[0].id].status == "sent"
    assert deliveries[matches[0].id].delivered_at is not None
    assert deliveries[matches[1].id].status == "sent"
    assert deliveries[matches[2].id].status == DIGEST_SKIPPED_DELIVERY_STATUS
    assert deliveries[matches[3].id].status == DIGEST_SKIPPED_DELIVERY_STATUS


async def test_not_configured_notifier_leaves_pending_items_pending_and_honest(
    session: Session,
) -> None:
    source, rule, recipient = _seed(session)
    match = _match(session, source, rule, message_id=1, price_cents=100_000)
    _queue_delivery(session, match, recipient)
    session.commit()

    now = datetime(2026, 9, 24, 12, 0, tzinfo=UTC)
    notifier = BotNotifier(bot_token=None, client=None, allowlisted_chat_ids={"999"})

    outcome = await run_digest_once(session, notifier, now=now, tz=SP, top_n=5)

    assert outcome.ran is True
    assert outcome.sent is False  # never faked as delivered
    delivery = session.scalar(select(Delivery).where(Delivery.match_id == match.id))
    assert delivery is not None
    assert delivery.status == "pending"  # not "sent": no client, no pretending
    # A digest_run row still exists — this local day will not be retried by
    # this same process; the item is picked up again only by a *future*
    # local day's run, still finding it pending.
    assert session.get(DigestRun, local_date_for(now, SP)) is not None


async def test_a_pending_item_left_over_from_an_unconfigured_run_is_picked_up_the_next_day(
    session: Session,
) -> None:
    source, rule, recipient = _seed(session)
    match = _match(session, source, rule, message_id=1, price_cents=100_000)
    _queue_delivery(session, match, recipient)
    session.commit()

    day_one = datetime(2026, 9, 24, 12, 0, tzinfo=UTC)
    unconfigured = BotNotifier(bot_token=None, client=None, allowlisted_chat_ids={"999"})
    await run_digest_once(session, unconfigured, now=day_one, tz=SP, top_n=5)

    day_two = day_one + timedelta(days=1)
    client = FakeBotClient()
    configured = BotNotifier(bot_token="token", client=client, allowlisted_chat_ids={"999"})
    outcome = await run_digest_once(session, configured, now=day_two, tz=SP, top_n=5)

    assert outcome.sent is True
    delivery = session.scalar(select(Delivery).where(Delivery.match_id == match.id))
    assert delivery is not None
    assert delivery.status == "sent"


class _SimulatedCrash(BaseException):
    """Stands in for a real process crash (SIGKILL, OOM, `docker restart` at
    the wrong instant) — deliberately a `BaseException`, not an `Exception`,
    so `run_digest_once`'s per-recipient `except Exception` (there precisely
    to isolate one recipient's ordinary send *failure* from the others) never
    swallows it. A real crash could not be caught by that `try` either.
    """


class _CrashingBotClient:
    """Records the send as really having happened — Telegram got the
    message — and only then "crashes", before `run_digest_once` can do
    anything else with the result.
    """

    def __init__(self) -> None:
        self.sent: list[tuple[str, str]] = []

    async def send_message(self, chat_id: str, text: str) -> None:
        self.sent.append((chat_id, text))
        raise _SimulatedCrash


async def test_a_crash_after_sending_but_before_the_final_commit_is_never_resent(
    session: Session, db_path: Path
) -> None:
    """Tech Lead review (PR #100): a restart mid-run must never resend, not
    only a *clean* restart between runs. `run_digest_once` commits the
    `DigestRun` reservation before sending anything — this crashes *after*
    the (fake) Telegram send truly happened, simulating the process dying
    before the function's closing commit ever runs. A brand-new session
    against the same database (a real restart, not just a new call in the
    same process) must still see the reservation and refuse to run again.
    """
    source, rule, recipient = _seed(session)
    match = _match(session, source, rule, message_id=1, price_cents=100_000)
    _queue_delivery(session, match, recipient)
    session.commit()

    client = _CrashingBotClient()
    notifier = BotNotifier(bot_token="token", client=client, allowlisted_chat_ids={"999"})
    now = datetime(2026, 9, 24, 12, 0, tzinfo=UTC)

    with pytest.raises(_SimulatedCrash):
        await run_digest_once(session, notifier, now=now, tz=SP, top_n=5)

    assert len(client.sent) == 1  # the send really happened, exactly once

    delivery = session.scalar(select(Delivery).where(Delivery.match_id == match.id))
    assert delivery is not None
    assert delivery.status == "pending"  # never marked "sent": the crash won that race

    # A genuinely new session against the same file (simulating the process
    # restarting), same local day: must find the reservation and no-op.
    restarted_session = get_sessionmaker(get_engine(f"sqlite:///{db_path}"))()
    try:
        outcome = await run_digest_once(restarted_session, notifier, now=now, tz=SP, top_n=5)
    finally:
        restarted_session.close()

    assert outcome.ran is False
    assert len(client.sent) == 1  # still exactly one send — never duplicated
