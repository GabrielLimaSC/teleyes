from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from sqlalchemy.orm import Session

from models import Delivery, Match, Recipient, Rule
from packages.events.broker import EventBroker
from packages.metrics.counters import MetricReason, increment_counter
from packages.notifications.bot import BotNotifier
from packages.rules.dedupe import DedupeCache, compute_signature
from packages.rules.match import MatchRule
from packages.rules.normalize import normalize_text
from packages.rules.price import extract_price


def parse_terms(raw: str | None) -> list[str]:
    """Split a comma-separated `Rule.include_terms`/`exclude_terms` into a term list."""
    if not raw:
        return []
    return [term.strip() for term in raw.split(",") if term.strip()]


@dataclass
class IncomingMessage:
    source_id: int
    message_id: int
    text: str
    link: str | None
    received_at: datetime


@dataclass
class ProcessResult:
    match: Match | None
    deliveries_sent: int
    reason: str | None = None


def _build_match_rule(rule: Rule) -> MatchRule:
    return MatchRule(
        include_terms=parse_terms(rule.include_terms),
        exclude_terms=parse_terms(rule.exclude_terms),
    )


def _discard_reason(match_rule: MatchRule, text: str) -> MetricReason:
    normalized = normalize_text(text)
    if any(normalize_text(term) in normalized for term in match_rule.exclude_terms):
        return MetricReason.BLOCKED
    return MetricReason.NO_TERM


async def process_message(
    session: Session,
    message: IncomingMessage,
    rule: Rule,
    recipients: list[Recipient],
    notifier: BotNotifier,
    dedupe_cache: DedupeCache,
) -> ProcessResult:
    """Run one incoming message through match -> price -> dedupe -> persist -> notify.

    Discards and failures are counted only by category (`packages.metrics`); the
    message text is never passed to a counter, so it has no path into a metric
    row. Reprocessing the same message with the same `dedupe_cache` is a no-op:
    the signature check short-circuits before a `Match`/`Delivery` row is ever
    created, so neither is duplicated.
    """
    match_rule = _build_match_rule(rule)

    if not match_rule.matches(message.text):
        reason = _discard_reason(match_rule, message.text)
        increment_counter(session, reason, source_id=message.source_id)
        return ProcessResult(match=None, deliveries_sent=0, reason=reason.value)

    price = extract_price(message.text)
    if (
        rule.max_price_cents is not None
        and price.price_cents is not None
        and price.price_cents > rule.max_price_cents
    ):
        increment_counter(session, MetricReason.PRICE_ABOVE_CEILING, source_id=message.source_id)
        return ProcessResult(
            match=None, deliveries_sent=0, reason=MetricReason.PRICE_ABOVE_CEILING.value
        )

    signature = compute_signature(message.source_id, message.text, price_cents=price.price_cents)
    if not dedupe_cache.should_process(signature):
        return ProcessResult(match=None, deliveries_sent=0, reason="duplicate")

    increment_counter(session, MetricReason.SEEN, source_id=message.source_id)

    db_match = Match(
        source_id=message.source_id,
        rule_id=rule.id,
        message_text=message.text,
        price_cents=price.price_cents,
        message_link=message.link,
        matched_at=message.received_at,
    )
    session.add(db_match)
    session.flush()

    deliveries_sent = 0
    for recipient in recipients:
        try:
            result = await notifier.notify(
                match_id=db_match.id,
                recipient_id=recipient.id,
                chat_id=recipient.telegram_chat_id,
                text=message.text,
            )
        except Exception:  # one recipient's delivery failure must not sink the whole batch
            increment_counter(session, MetricReason.DELIVERY_FAILURE, source_id=message.source_id)
            session.add(
                Delivery(match_id=db_match.id, recipient_id=recipient.id, status="failed")
            )
            continue

        if result.delivered:
            deliveries_sent += 1

        session.add(
            Delivery(
                match_id=db_match.id,
                recipient_id=recipient.id,
                status="sent" if result.delivered else (result.reason or "skipped"),
                delivered_at=datetime.now(UTC) if result.delivered else None,
            )
        )

    session.flush()

    return ProcessResult(match=db_match, deliveries_sent=deliveries_sent)


def build_match_event(result: ProcessResult) -> dict[str, Any] | None:
    """Build the `match` SSE payload for a `ProcessResult`, or `None` if it was a discard."""
    if result.match is None:
        return None
    return {
        "match_id": result.match.id,
        "source_id": result.match.source_id,
        "rule_id": result.match.rule_id,
        "price_cents": result.match.price_cents,
        "message_link": result.match.message_link,
        "matched_at": result.match.matched_at.isoformat(),
        "deliveries_sent": result.deliveries_sent,
    }


def publish_match_event(broker: EventBroker, result: ProcessResult) -> None:
    """Publish the `match` SSE event for a `ProcessResult`.

    Call this only after the caller's `session.commit()` has succeeded — a match
    must never reach the live feed before it is durably persisted.
    """
    event = build_match_event(result)
    if event is not None:
        broker.publish("match", event)
