from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, sessionmaker

from models import Delivery, Match, Recipient, Rule
from packages.events.broker import EventBroker
from packages.metrics.counters import MetricReason, increment_counter
from packages.notifications.bot import BotNotifier
from packages.rules.dedupe import DedupeCache, compute_signature
from packages.rules.match import MatchRule
from packages.rules.normalize import normalize_text
from packages.rules.price import extract_price
from packages.telegram.cursor import MessageFetcherProtocol, advance_cursor, backfill_since_cursor


def parse_terms(raw: str | None) -> list[str]:
    """Split a comma-separated `Rule.include_terms`/`exclude_terms` into a term list."""
    if not raw:
        return []
    return [term.strip() for term in raw.split(",") if term.strip()]


@dataclass
class IncomingMessage:
    source_id: int
    message_id: int | None
    text: str
    link: str | None
    received_at: datetime


@dataclass
class ProcessResult:
    match: Match | None
    deliveries_sent: int
    reason: str | None = None


@dataclass
class ListenerSource:
    """Everything `catch_up_since_cursor` needs to recover one source's gap.

    `rules` is a list, not one `Rule`: the schema has no rule<->source or
    rule<->recipient relationship at all (checked against
    `apps/api/models/*.py` and the CRUD routers before writing this, S5-09) —
    every active rule is evaluated against every active source's messages,
    and every match goes to every active, allowlisted recipient. One
    `ProcessingCursor` per source (unique on `source_id` alone) means the
    backfill fetch itself must run once per source, then be evaluated against
    every rule — never once per (source, rule) pair, which would advance the
    shared cursor on the first rule and starve every rule after it of the
    same recovered messages.
    """

    source_id: int
    chat_id: str
    rules: list[Rule]
    recipients: list[Recipient]


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
    row. A real Telegram identity is also protected by a database constraint,
    so reprocessing it is a no-op even with another session/process and a cold
    `dedupe_cache`. Inputs without an identity retain the legacy memory-only
    behavior explicitly.

    Also advances the source's persisted cursor (`packages.telegram.cursor`) for
    real messages, matched or not — without that, a later backfill (a process
    restart or a reconnect after a short drop) would re-fetch and re-notify a
    message already delivered here. Synthetic/legacy inputs use a NULL identity
    and do not invent or advance a Telegram cursor.
    """
    if message.message_id is not None:
        advance_cursor(session, message.source_id, message.message_id)

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

    signature = compute_signature(
        message.source_id,
        message.text,
        price_cents=price.price_cents,
        rule_id=rule.id,
    )
    if not dedupe_cache.should_process(signature):
        return ProcessResult(match=None, deliveries_sent=0, reason="duplicate")

    db_match = Match(
        source_id=message.source_id,
        rule_id=rule.id,
        telegram_message_id=message.message_id,
        message_text=message.text,
        price_cents=price.price_cents,
        message_link=message.link,
        matched_at=message.received_at,
    )
    try:
        # Keep the insert in a savepoint: a second process may race this one
        # after its own in-memory cache starts cold. The database constraint is
        # authoritative, and rolling back only this savepoint leaves the outer
        # transaction (including its cursor advance) usable by the caller.
        with session.begin_nested():
            session.add(db_match)
            session.flush()
    except IntegrityError:
        if message.message_id is None:
            raise
        existing_match_id = session.scalar(
            select(Match.id).where(
                Match.source_id == message.source_id,
                Match.rule_id == rule.id,
                Match.telegram_message_id == message.message_id,
            )
        )
        if existing_match_id is None:
            raise
        return ProcessResult(match=None, deliveries_sent=0, reason="duplicate")

    increment_counter(session, MetricReason.SEEN, source_id=message.source_id)

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


async def catch_up_since_cursor(
    session_factory: sessionmaker[Session],
    fetcher: MessageFetcherProtocol,
    source: ListenerSource,
    notifier: BotNotifier,
    dedupe_cache: DedupeCache,
    *,
    max_messages: int = 100,
    max_age: timedelta | None = timedelta(hours=24),
) -> list[ProcessResult]:
    """Recover messages missed while disconnected, through the real pipeline.

    Call this after every successful connect — the very first one in a fresh
    process (recovers whatever was missed while it was down, i.e. a restart)
    and again after any reconnect (recovers a short connection drop's gap).
    Bounded by `max_messages`/`max_age` so a long gap doesn't replay a
    source's entire history — messages older than the bound are permanently
    skipped, not queued for later, matching `backfill_since_cursor`'s own
    contract. Each recovered message runs through the same `process_message`
    as a live one, so matching/pricing/dedupe/notification and the cursor
    advance itself all stay identical between the two paths.
    """
    with session_factory() as cursor_session:
        recovered = await backfill_since_cursor(
            cursor_session,
            fetcher,
            source.source_id,
            source.chat_id,
            max_messages=max_messages,
            max_age=max_age,
        )
        cursor_session.commit()

    results: list[ProcessResult] = []
    for raw in recovered:
        for rule in source.rules:
            with session_factory() as session:
                incoming = IncomingMessage(
                    source_id=source.source_id,
                    message_id=raw.id,
                    text=raw.text,
                    link=None,
                    received_at=raw.date,
                )
                result = await process_message(
                    session, incoming, rule, source.recipients, notifier, dedupe_cache
                )
                session.commit()
                results.append(result)
    return results


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
