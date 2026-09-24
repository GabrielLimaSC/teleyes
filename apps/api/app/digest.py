"""S14-04 (F4): daily digest — an in-process asyncio scheduler, no Celery, no
external cron (CLAUDE.md: this project stays a single operable process).

`DigestScheduler.run` is one more background task the listener process starts
alongside `ReloadWorker`/`run_heartbeat` (`scripts/run_listener.py`), polling
every `DIGEST_POLL_SECONDS`. Idempotency lives entirely in the database
(`DigestRun.local_date`, primary key), never in scheduler state, so a restart
mid-day, two overlapping ticks, or a process that comes back up after the
send time already passed all resolve the same way:

- a `digest_run` row already exists for today's local date -> no-op, whatever
  triggers the check (`run_digest_once` is the single gate every caller goes
  through);
- no row yet and the local clock has reached `send_at_local` -> runs once,
  right there on the next tick — including the very first tick after a
  process that was down *through* the send time, which is exactly the "envia
  uma vez ao subir" done_when;
- the local day rolls over with no row ever written (digest was off, or the
  process was down the whole day) -> nothing recovers that day; the next
  `digest_run` this process ever writes is for whatever "today" is when it
  next ticks past `send_at_local`, never a backlog of missed days.

`process_message` (app/pipeline.py) is the only writer of `Delivery(kind=
"digest", status="pending")` rows — one per (match, recipient) held back
instead of notified immediately (see its own S14-04 branch). This module only
ever reads that queue and, once a day, folds it into one message per
recipient and marks each included row `"sent"` after confirmation or (past
`top_n`) `DIGEST_SKIPPED_DELIVERY_STATUS`. Selection and `top_n` are per recipient.
Before the first external call, every selected delivery is durably changed to
`DIGEST_ATTEMPTED_DELIVERY_STATUS`; that terminal ambiguous state is the
at-most-once boundary after a crash or timeout.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, sessionmaker

from app.config import get_settings
from app.digest_settings import load_digest_settings, parse_send_at_local
from app.pipeline import (
    DELIVERY_KIND_DIGEST,
    DIGEST_ATTEMPTED_DELIVERY_STATUS,
    DIGEST_SKIPPED_DELIVERY_STATUS,
)
from app.utc import ensure_utc
from models import Delivery, DigestRun, Match, Recipient
from packages.notifications.bot import BotNotifier
from packages.notifications.formatting import format_price_cents
from packages.rules.product import product_title

logger = logging.getLogger(__name__)

DIGEST_POLL_SECONDS = 30.0


def local_date_for(now_utc: datetime, tz: ZoneInfo) -> date:
    return ensure_utc(now_utc).astimezone(tz).date()


def next_run_at(
    *, now_utc: datetime, tz: ZoneInfo, send_at_local: time, already_ran_today: bool
) -> datetime:
    """The next scheduled instant, aware UTC, for `GET /digest`'s "Próximo
    envio" and the scheduler's own reasoning.

    Once today's local day already has a `digest_run`, the next slot is
    tomorrow's `send_at_local`. Otherwise it is today's — even if the wall
    clock has technically already passed it, which just means it is due any
    moment (or overdue because the process was down), not skipped: matches
    `run_digest_once`'s own "no row yet -> still today" gate.
    """
    local_now = ensure_utc(now_utc).astimezone(tz)
    local_day = local_now.date() + timedelta(days=1) if already_ran_today else local_now.date()
    local_instant = datetime.combine(local_day, send_at_local, tzinfo=tz)
    return local_instant.astimezone(UTC)


@dataclass(frozen=True)
class DigestQueueItem:
    match_id: int
    price_cents: int | None
    title: str
    message_link: str | None
    matched_at: datetime


def _title_for(match: Match) -> str:
    """A human-readable line for the digest text — the same product-title
    extraction the panel and the snooze labels use (`packages.rules.product`),
    falling back to the message's first line when no product title was found
    (e.g. a match with no recognisable product, per S14-01's `product_key`).
    """
    title = product_title(match.message_text)
    if title is not None:
        return title
    return match.message_text.splitlines()[0][:120]


def load_pending_queue(
    session: Session, *, recipient_id: int | None = None
) -> list[DigestQueueItem]:
    """Every distinct `Match` with at least one pending digest delivery,
    lowest price first (a match with no extracted price sorts last), oldest
    match as the tiebreak so the ordering is stable and deterministic.

    With `recipient_id`, only that recipient's pending rows are eligible. The
    scheduler always uses this scoped form: delivery outcomes can diverge per
    recipient, so neither message contents nor `top_n` may be shared globally.
    The unscoped form is only the distinct aggregate shown by `GET /digest`.
    """
    statement = (
        select(Match)
        .join(Delivery, Delivery.match_id == Match.id)
        .where(Delivery.kind == DELIVERY_KIND_DIGEST, Delivery.status == "pending")
        .distinct()
    )
    if recipient_id is not None:
        statement = statement.where(Delivery.recipient_id == recipient_id)
    matches = session.scalars(statement).all()
    items = [
        DigestQueueItem(
            match_id=match.id,
            price_cents=match.price_cents,
            title=_title_for(match),
            message_link=match.message_link,
            matched_at=ensure_utc(match.matched_at),
        )
        for match in matches
    ]
    items.sort(
        key=lambda item: (
            item.price_cents is None,
            item.price_cents if item.price_cents is not None else 0,
            item.matched_at,
            item.match_id,
        )
    )
    return items


def build_digest_text(items: Sequence[DigestQueueItem]) -> str:
    """pt-BR digest text: cheapest first, with the original link when there is
    one — mirrors `build_target_alert_text`'s plain, no-locale-module currency
    formatting (`format_price_cents`).
    """
    lines = [f"📋 Resumo do dia — {len(items)} oferta(s):", ""]
    for item in items:
        price = (
            format_price_cents(item.price_cents)
            if item.price_cents is not None
            else "preço não identificado"
        )
        line = f"• {price} — {item.title}"
        if item.message_link:
            line += f" ({item.message_link})"
        lines.append(line)
    return "\n".join(lines)


def _mark_deliveries(
    session: Session,
    match_ids: Sequence[int],
    recipient_id: int,
    *,
    status: str,
    delivered_at: datetime | None = None,
    from_status: str = "pending",
) -> None:
    """Transition only rows in the expected source state for one recipient.

    This compare-and-set shape prevents a later transition from overwriting a
    grouped, sent, or otherwise unrelated delivery.
    """
    if not match_ids:
        return
    session.execute(
        update(Delivery)
        .where(
            Delivery.match_id.in_(match_ids),
            Delivery.recipient_id == recipient_id,
            Delivery.kind == DELIVERY_KIND_DIGEST,
            Delivery.status == from_status,
        )
        .values(status=status, delivered_at=delivered_at)
    )


@dataclass(frozen=True)
class RecipientDigestPlan:
    recipient_id: int
    chat_id: str
    top_items: tuple[DigestQueueItem, ...]
    overflow_items: tuple[DigestQueueItem, ...]

    @property
    def top_match_ids(self) -> list[int]:
        return [item.match_id for item in self.top_items]

    @property
    def overflow_match_ids(self) -> list[int]:
        return [item.match_id for item in self.overflow_items]


@dataclass(frozen=True)
class DigestRunOutcome:
    # False only when today's local date already had a `digest_run` row —
    # every caller (the scheduler, a manual trigger) treats that as "already
    # handled", not an error.
    ran: bool
    items_sent: int
    items_skipped: int
    # Whether the message actually reached at least one recipient (honest:
    # `False` with `items_sent > 0` means external attempts were ambiguous;
    # their rows remain terminal `digest_attempted`, never falsely `"sent"`.
    sent: bool


async def run_digest_once(
    session: Session,
    notifier: BotNotifier,
    *,
    now: datetime,
    tz: ZoneInfo,
    top_n: int,
) -> DigestRunOutcome:
    """The single entry point the scheduler (and any future manual trigger)
    calls. Idempotent by `DigestRun.local_date` (primary key) — a second call
    for the same local day, from any process or session, is a guaranteed
    no-op checked first, before anything else runs.

    Idempotency has two durable layers. `DigestRun` reserves the local date
    before queue processing, preserving the one-run-per-day concurrency gate.
    Then every recipient's selected rows are reserved together as
    `digest_attempted` before the first Bot API call. That second state is
    terminal if a call crashes or raises: once an external request starts, we
    cannot know whether Telegram accepted it, so at-most-once deliberately
    prefers a possibly lost digest to a duplicate on this or any later day.
    Known local blocks (`not_configured`/`not_allowlisted`) are detected before
    reservation and remain honestly pending.

    The `IntegrityError` catch below is the same guarantee under a genuine
    race (two processes/sessions both passing the `session.get` check for the
    same local date before either commits) — the primary key is what actually
    decides, not the read that preceded it.
    """
    local_date = local_date_for(now, tz)
    if session.get(DigestRun, local_date) is not None:
        return DigestRunOutcome(ran=False, items_sent=0, items_skipped=0, sent=False)

    run = DigestRun(local_date=local_date, ran_at=datetime.now(UTC))
    session.add(run)
    try:
        session.commit()
    except IntegrityError:
        session.rollback()
        return DigestRunOutcome(ran=False, items_sent=0, items_skipped=0, sent=False)

    recipients = list(
        session.scalars(
            select(Recipient).where(
                Recipient.active.is_(True), Recipient.allowlisted.is_(True)
            ).order_by(Recipient.id)
        )
    )

    plans: list[RecipientDigestPlan] = []
    for recipient in recipients:
        # A known local block means no external call can start, so this
        # recipient's entire queue remains honestly pending for a future day.
        if notifier.delivery_block_reason(recipient.telegram_chat_id) is not None:
            continue
        queue = load_pending_queue(session, recipient_id=recipient.id)
        if not queue:
            continue
        plans.append(
            RecipientDigestPlan(
                recipient_id=recipient.id,
                chat_id=recipient.telegram_chat_id,
                top_items=tuple(queue[:top_n]),
                overflow_items=tuple(queue[top_n:]),
            )
        )

    # Reserve every selected delivery for every recipient in one durable
    # phase before the first network await. `digest_attempted` is terminal,
    # because a crash/timeout after the Bot API receives the request is
    # observationally indistinguishable from a failed request. At-most-once
    # deliberately prefers a possibly lost digest to a duplicate.
    items_sent = sum(len(plan.top_items) for plan in plans)
    items_skipped = sum(len(plan.overflow_items) for plan in plans)
    for plan in plans:
        _mark_deliveries(
            session,
            plan.top_match_ids,
            plan.recipient_id,
            status=DIGEST_ATTEMPTED_DELIVERY_STATUS,
        )
        _mark_deliveries(
            session,
            plan.overflow_match_ids,
            plan.recipient_id,
            status=DIGEST_SKIPPED_DELIVERY_STATUS,
        )
    run.items_sent = items_sent
    run.items_skipped = items_skipped
    session.commit()

    sent_to_anyone = False
    for plan in plans:
        try:
            result = await notifier.notify_digest(
                plan.chat_id, build_digest_text(plan.top_items)
            )
        except Exception:
            # The external call began. Its result may be ambiguous, so the
            # durable attempted state is terminal and is never re-queued.
            logger.error("event=digest_send_ambiguous recipient_id=%s", plan.recipient_id)
            continue
        if result.delivered:
            sent_to_anyone = True
            _mark_deliveries(
                session,
                plan.top_match_ids,
                plan.recipient_id,
                status="sent",
                delivered_at=datetime.now(UTC),
                from_status=DIGEST_ATTEMPTED_DELIVERY_STATUS,
            )
            session.commit()
            continue

        # A reload may remove this chat from the notifier allowlist while an
        # earlier recipient's network call is awaiting. The notifier then
        # returns before touching the external client, so reverting this
        # recipient's reservation is safe and preserves an honest pending
        # queue. No other false result exists today.
        if result.reason in {"not_configured", "not_allowlisted"}:
            _mark_deliveries(
                session,
                plan.top_match_ids,
                plan.recipient_id,
                status="pending",
                from_status=DIGEST_ATTEMPTED_DELIVERY_STATUS,
            )
            _mark_deliveries(
                session,
                plan.overflow_match_ids,
                plan.recipient_id,
                status="pending",
                from_status=DIGEST_SKIPPED_DELIVERY_STATUS,
            )
            items_sent -= len(plan.top_items)
            items_skipped -= len(plan.overflow_items)
            run.items_sent = items_sent
            run.items_skipped = items_skipped
            session.commit()

    return DigestRunOutcome(
        ran=True,
        items_sent=items_sent,
        items_skipped=items_skipped,
        sent=sent_to_anyone,
    )


class DigestScheduler:
    """The listener process's background task (`scripts/run_listener.py`
    starts it the same way it starts `ReloadWorker`/`run_heartbeat`): polls
    `digest_settings` and, once the local clock reaches `send_at_local`, calls
    `run_digest_once`. Polling instead of a precise timer for the same reason
    `ReloadWorker` does — a late tick by up to `poll_seconds` is harmless
    because the send itself is idempotent by local date, not by exact minute.
    """

    def __init__(
        self,
        *,
        session_factory: sessionmaker[Session],
        notifier: BotNotifier,
        now: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self._session_factory = session_factory
        self._notifier = notifier
        self._now = now

    async def tick(self) -> DigestRunOutcome | None:
        """One check. Returns `None` when the digest is off, its
        `send_at_local` is malformed, or the local clock has not reached it
        yet today — every one of those is "nothing to do", not an error.
        """
        now = self._now()
        with self._session_factory() as session:
            settings = load_digest_settings(session)
            if not settings.enabled:
                return None
            try:
                send_at = parse_send_at_local(settings.send_at_local)
            except ValueError:
                logger.error(
                    "event=digest_invalid_send_at_local value=%s", settings.send_at_local
                )
                return None

            tz = ZoneInfo(get_settings().display_timezone)
            local_now = ensure_utc(now).astimezone(tz)
            if local_now.time() < send_at:
                return None

            outcome = await run_digest_once(
                session, self._notifier, now=now, tz=tz, top_n=settings.top_n
            )
        if outcome.ran:
            logger.info(
                "event=digest_run items_sent=%d items_skipped=%d sent=%s",
                outcome.items_sent,
                outcome.items_skipped,
                outcome.sent,
            )
        return outcome

    async def run(
        self, stop_event: asyncio.Event, poll_seconds: float = DIGEST_POLL_SECONDS
    ) -> None:
        while not stop_event.is_set():
            try:
                await self.tick()
            except Exception as error:
                logger.error("event=digest_tick_failed error_class=%s", type(error).__name__)
            try:
                await asyncio.wait_for(stop_event.wait(), timeout=poll_seconds)
            except TimeoutError:
                pass
