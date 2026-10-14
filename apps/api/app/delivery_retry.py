"""Periodic resend of recent failed alerts (S17-01).

`process_message` records a `Delivery(status="failed")` when the Bot API send
still fails after its in-place retries (a network blip, the machine asleep).
This pass picks those rows up again and, on success, updates the SAME row to
`sent` (no new column, no migration).

Rules, all checked against the stored data only:

- only `failed` rows of the `immediate` and `target` channels, younger than
  `RESEND_MAX_AGE`; `sent`, `historical`, `grouped`, `snoozed`, digest and
  manual-target rows are never touched;
- an `immediate` alert is re-checked against the snooze and the digest setting
  *now* and left alone if either would hold it back; a `target` alert pierces
  both, as in the original send;
- the target text is rebuilt with `build_target_alert_text`, like the first send;
- no transaction is held across the network: a short read, the send, then a
  short write that only flips a row that is still `failed`.

Duplicate protection after a restart comes from the database: once a row is
`sent` it is not a candidate any more. The only window is a crash between a
successful send and its status write. Logs carry ids and error classes only.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy import select, update
from sqlalchemy.orm import Session, sessionmaker

from app.db_retry import retry_when_locked
from app.delivery_policy import is_snoozed
from app.digest_settings import load_digest_settings
from app.pipeline import (
    DELIVERY_KIND_IMMEDIATE,
    DELIVERY_KIND_TARGET,
    build_target_alert_text,
)
from app.utc import ensure_utc
from models import Delivery, Match, Recipient, Rule
from packages.notifications.bot import BotNotifier

logger = logging.getLogger(__name__)

RESEND_MAX_AGE = timedelta(hours=6)
RESENDABLE_KINDS = (DELIVERY_KIND_IMMEDIATE, DELIVERY_KIND_TARGET)


@dataclass(frozen=True)
class _Candidate:
    delivery_id: int
    match_id: int
    recipient_id: int
    chat_id: str
    kind: str
    text: str


def _load_candidates(
    session_factory: sessionmaker[Session], *, now: datetime, max_age: timedelta
) -> list[_Candidate]:
    """Short read transaction; everything needed later is copied out of it."""
    cutoff = ensure_utc(now) - max_age
    candidates: list[_Candidate] = []
    with session_factory() as session:
        rows = session.execute(
            select(Delivery, Match, Recipient, Rule)
            .join(Match, Delivery.match_id == Match.id)
            .join(Recipient, Delivery.recipient_id == Recipient.id)
            .join(Rule, Match.rule_id == Rule.id)
            .where(
                Delivery.status == "failed",
                Delivery.kind.in_(RESENDABLE_KINDS),
                Delivery.created_at >= cutoff,
                Recipient.active.is_(True),
                Recipient.allowlisted.is_(True),
            )
            .order_by(Delivery.id)
        ).all()
        digest = load_digest_settings(session)
        digest_holds_individual = digest.enabled and digest.mute_individual
        for delivery, match, recipient, rule in rows:
            text = match.message_text
            if delivery.kind == DELIVERY_KIND_TARGET:
                price = (
                    match.original_price_cents
                    if match.price_source == "manual" and match.original_price_cents is not None
                    else match.price_cents
                )
                if price is None or rule.target_price_cents is None:
                    continue  # cannot rebuild the target text: leave it failed
                text = build_target_alert_text(text, rule, price)
            else:
                if digest_holds_individual or is_snoozed(
                    session,
                    rule_id=rule.id,
                    product_key=match.product_key,
                    now=now,
                ):
                    continue
            candidates.append(
                _Candidate(
                    delivery_id=delivery.id,
                    match_id=match.id,
                    recipient_id=recipient.id,
                    chat_id=recipient.telegram_chat_id,
                    kind=delivery.kind,
                    text=text,
                )
            )
    return candidates


def _mark_sent(session_factory: sessionmaker[Session], delivery_id: int) -> None:
    with session_factory() as session:
        session.execute(
            update(Delivery)
            .where(Delivery.id == delivery_id, Delivery.status == "failed")
            .values(status="sent", delivered_at=datetime.now(UTC))
        )
        session.commit()


async def _mark_sent_retrying(session_factory: sessionmaker[Session], delivery_id: int) -> None:
    await retry_when_locked(lambda: _mark_sent(session_factory, delivery_id))


async def resend_failed_deliveries(
    session_factory: sessionmaker[Session],
    notifier: BotNotifier,
    *,
    now: datetime | None = None,
    max_age: timedelta = RESEND_MAX_AGE,
) -> int:
    """Try once to resend each recent failed alert; returns how many went out."""
    moment = now or datetime.now(UTC)
    candidates = _load_candidates(session_factory, now=moment, max_age=max_age)
    resent = 0
    for candidate in candidates:
        try:
            result = await notifier.notify(
                match_id=candidate.match_id,
                recipient_id=candidate.recipient_id,
                chat_id=candidate.chat_id,
                text=candidate.text,
            )
        except Exception as error:
            logger.warning(
                "event=notify_resend_failed match_id=%d recipient_id=%d kind=%s error_class=%s",
                candidate.match_id,
                candidate.recipient_id,
                candidate.kind,
                type(error).__name__,
            )
            continue
        # "duplicate" means this process already delivered that pair, so the row
        # is stale rather than unsent: record it as sent without a second message.
        if not (result.delivered or result.reason == "duplicate"):
            continue
        await _mark_sent_retrying(session_factory, candidate.delivery_id)
        if result.delivered:
            resent += 1
            logger.info(
                "event=notify_resent match_id=%d recipient_id=%d kind=%s",
                candidate.match_id,
                candidate.recipient_id,
                candidate.kind,
            )
    return resent
