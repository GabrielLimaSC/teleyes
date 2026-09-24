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
recipient and marks each included row `"sent"` or (past `top_n`)
`DIGEST_SKIPPED_DELIVERY_STATUS`.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import select, update
from sqlalchemy.orm import Session, sessionmaker

from app.config import get_settings
from app.digest_settings import load_digest_settings, parse_send_at_local
from app.pipeline import DELIVERY_KIND_DIGEST, DIGEST_SKIPPED_DELIVERY_STATUS
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


def load_pending_queue(session: Session) -> list[DigestQueueItem]:
    """Every distinct `Match` with at least one pending digest delivery,
    lowest price first (a match with no extracted price sorts last), oldest
    match as the tiebreak so the ordering is stable and deterministic.

    One row per `Match` even though a `Delivery` exists per recipient: every
    active, allowlisted recipient gets the exact same set today (no per-
    recipient targeting anywhere in this schema, S5-09's own finding), so the
    queue itself — what `top_n` cuts against — is recipient-independent.
    """
    matches = (
        session.scalars(
            select(Match)
            .join(Delivery, Delivery.match_id == Match.id)
            .where(Delivery.kind == DELIVERY_KIND_DIGEST, Delivery.status == "pending")
            .distinct()
        )
    ).all()
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
) -> None:
    """Only ever touches the `"pending"` digest rows this run itself is
    settling — never a `"grouped"`/`"failed"`/already-`"sent"` row from a
    different match/recipient pair.
    """
    if not match_ids:
        return
    session.execute(
        update(Delivery)
        .where(
            Delivery.match_id.in_(match_ids),
            Delivery.recipient_id == recipient_id,
            Delivery.kind == DELIVERY_KIND_DIGEST,
            Delivery.status == "pending",
        )
        .values(status=status, delivered_at=delivered_at)
    )


@dataclass(frozen=True)
class DigestRunOutcome:
    # False only when today's local date already had a `digest_run` row —
    # every caller (the scheduler, a manual trigger) treats that as "already
    # handled", not an error.
    ran: bool
    items_sent: int
    items_skipped: int
    # Whether the message actually reached at least one recipient (honest:
    # `False` with `items_sent > 0` means a `not_configured`/failed notifier
    # left every included item `"pending"` — see the loop below — never
    # `"sent"` on a channel that never delivered.
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
    """
    local_date = local_date_for(now, tz)
    if session.get(DigestRun, local_date) is not None:
        return DigestRunOutcome(ran=False, items_sent=0, items_skipped=0, sent=False)

    queue = load_pending_queue(session)
    top_items, overflow_items = queue[:top_n], queue[top_n:]

    recipients: list[Recipient] = []
    if top_items or overflow_items:
        recipients = list(
            session.scalars(
                select(Recipient).where(
                    Recipient.active.is_(True), Recipient.allowlisted.is_(True)
                )
            )
        )

    sent_to_anyone = False
    if top_items:
        text = build_digest_text(top_items)
        match_ids = [item.match_id for item in top_items]
        for recipient in recipients:
            try:
                result = await notifier.notify_digest(recipient.telegram_chat_id, text)
            except Exception:
                # One recipient's send failure must not sink the others', nor
                # the whole run — every other recipient still gets a chance,
                # and the failed one's items simply stay `"pending"` (honest:
                # never faked as delivered) for the next real send attempt.
                logger.error("event=digest_send_failed recipient_id=%s", recipient.id)
                continue
            if result.delivered:
                sent_to_anyone = True
                _mark_deliveries(
                    session,
                    match_ids,
                    recipient.id,
                    status="sent",
                    delivered_at=datetime.now(UTC),
                )
            # `not_configured` / `not_allowlisted`: left `"pending"` on
            # purpose — the notifier never fakes delivery (CLAUDE.md), and a
            # `digest_run` row is still written below so this local day is
            # never retried; homologation with a real bot token is what
            # actually proves delivery, not this function.

    if overflow_items:
        overflow_ids = [item.match_id for item in overflow_items]
        for recipient in recipients:
            _mark_deliveries(
                session, overflow_ids, recipient.id, status=DIGEST_SKIPPED_DELIVERY_STATUS
            )

    session.add(
        DigestRun(
            local_date=local_date,
            ran_at=datetime.now(UTC),
            items_sent=len(top_items),
            items_skipped=len(overflow_items),
        )
    )
    session.commit()

    return DigestRunOutcome(
        ran=True,
        items_sent=len(top_items),
        items_skipped=len(overflow_items),
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
