from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Protocol

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, sessionmaker

from app.utc import format_utc
from models import Delivery, Match, Recipient, Rule
from packages.events.broker import EventBroker
from packages.metrics.counters import MetricReason, increment_counter
from packages.notifications.bot import BotNotifier
from packages.rules.dedupe import DedupeCache, compute_signature
from packages.rules.match import MatchRule
from packages.rules.normalize import normalize_text
from packages.rules.price import extract_price
from packages.telegram.cursor import (
    MessageFetcherProtocol,
    advance_cursor,
    backfill_since_cursor,
    has_cursor,
)
from packages.telegram.historical import (
    RecentMessageFetcherProtocol,
    fetch_messages_since,
    latest_message_id,
)
from packages.telegram.links import build_message_link


class ListenerFetcherProtocol(MessageFetcherProtocol, RecentMessageFetcherProtocol, Protocol):
    """Structural union of both fetch shapes the listener startup path needs:
    `iter_messages` (cursor-bounded, live/reconnect) and `iter_recent`
    (unbounded, historical/head-lookup). `TelethonMessageFetcher` and the
    tests' `FakeTelegramClient` already implement both.
    """

HISTORICAL_DELIVERY_STATUS = "historical"
# S7-11: a different source posting the same real-world promotion (same
# rule, same exact price) within this window of another match that was
# already really sent gets persisted normally but never re-notified — a
# named constant, not a magic number, tunable in one place. The task's own
# description ("1 a 10 minutos de diferença") suggested 15 minutes as a
# margin over that.
GROUPED_DELIVERY_STATUS = "grouped"
GROUPING_WINDOW = timedelta(minutes=15)
# S13-05: how far back the non-notifying historical scan looks (S6-02/S7-04),
# widened from 7 to 15 days at Gabriel's request. The single source of truth:
# `run_historical_scan`, `ListenerLifecycle` and `scripts/run_listener.py` all
# default to it. Unrelated to the reconnect catch-up's `max_age` (24h).
HISTORICAL_WINDOW = timedelta(days=15)


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


@dataclass
class RuleEvaluation:
    price_cents: int | None
    discard_reason: MetricReason | None
    # S7-05: only ever both set together, and only when extract_price found
    # two explicit, distinct textual anchors — see packages.rules.price.
    price_cash_cents: int | None = None
    price_card_cents: int | None = None


def _evaluate_rule(rule: Rule, text: str) -> RuleEvaluation:
    """Match -> price, with no side effect of its own.

    Shared by the live and historical paths (S6-02) precisely so neither one
    duplicates the matching/pricing logic — they differ only in what happens
    *after* this: the live path counts discards/matches and notifies, the
    historical path never touches a metric counter at all (a homologation
    scan of the historical window must not inflate the counters that
    describe live traffic health, and would double-count on every listener
    restart if it did, since `MetricCounter` is cumulative, not deduplicated
    by identity).
    """
    match_rule = _build_match_rule(rule)
    if not match_rule.matches(text):
        return RuleEvaluation(price_cents=None, discard_reason=_discard_reason(match_rule, text))

    price = extract_price(text)
    if (
        rule.max_price_cents is not None
        and price.price_cents is not None
        and price.price_cents > rule.max_price_cents
    ):
        return RuleEvaluation(price_cents=None, discard_reason=MetricReason.PRICE_ABOVE_CEILING)

    return RuleEvaluation(
        price_cents=price.price_cents,
        discard_reason=None,
        price_cash_cents=price.price_cash_cents,
        price_card_cents=price.price_card_cents,
    )


def _persist_match(
    session: Session,
    message: IncomingMessage,
    rule: Rule,
    price_cents: int | None,
    *,
    price_cash_cents: int | None = None,
    price_card_cents: int | None = None,
) -> Match | None:
    """Insert a `Match`, or return `None` if the S6-01 identity already exists.

    Shared by the live and historical paths: a real `telegram_message_id`
    makes `(source_id, rule_id, telegram_message_id)` unique, so a second
    insert of the same message+rule from another process, another session, or
    a repeated historical scan is a no-op here — no extra cache needed for
    either path to be idempotent across restarts.
    """
    db_match = Match(
        source_id=message.source_id,
        rule_id=rule.id,
        telegram_message_id=message.message_id,
        message_text=message.text,
        price_cents=price_cents,
        price_cash_cents=price_cash_cents,
        price_card_cents=price_card_cents,
        message_link=message.link,
        matched_at=message.received_at,
    )
    try:
        # Keep the insert in a savepoint: a second process may race this one
        # after its own in-memory cache starts cold. The database constraint is
        # authoritative, and rolling back only this savepoint leaves the outer
        # transaction (including a live caller's cursor advance) usable.
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
        return None
    return db_match


def _already_notified_group_match_exists(
    session: Session,
    rule_id: int,
    price_cents: int,
    matched_at: datetime,
    window: timedelta,
) -> bool:
    """S7-11: whether some other `Match` (any source) for the same rule and
    the exact same price, within `window` of `matched_at`, already has a real
    successful send — never `"historical"`/`"grouped"`/`"failed"`/etc., only
    the literal `"sent"` status `process_message` uses below. Safe to compare
    live against what's already committed in the database precisely because
    live events arrive in real chronological order (unlike the historical
    scan, S6-02) — no risk of a later message actually being the earlier one.

    Deliberately conservative: this only ever looks at a genuinely-sent
    delivery as the "this promotion already alerted" anchor. A chain of
    postings spread out past `window` from that original alert (but each
    individually close to its own neighbor) can still notify again — that's
    a known v1 limitation, not a bug, registered rather than solved with an
    unconfirmed heuristic (CLAUDE.md: no fuzzy matching without real
    examples). The read-time display grouping (`app.routers.matches`) covers
    that wider chain visually regardless.
    """
    window_start = matched_at - window
    window_end = matched_at + window
    exists_stmt = (
        select(Match.id)
        .join(Delivery, Delivery.match_id == Match.id)
        .where(
            Match.rule_id == rule_id,
            Match.price_cents == price_cents,
            Match.matched_at >= window_start,
            Match.matched_at <= window_end,
            Delivery.status == "sent",
        )
        .limit(1)
    )
    return session.scalar(exists_stmt) is not None


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

    evaluation = _evaluate_rule(rule, message.text)
    if evaluation.discard_reason is not None:
        increment_counter(session, evaluation.discard_reason, source_id=message.source_id)
        return ProcessResult(match=None, deliveries_sent=0, reason=evaluation.discard_reason.value)

    signature = compute_signature(
        message.source_id,
        message.text,
        price_cents=evaluation.price_cents,
        rule_id=rule.id,
    )
    if not dedupe_cache.should_process(signature):
        return ProcessResult(match=None, deliveries_sent=0, reason="duplicate")

    # S7-11: computed before persisting this match, so it can never see
    # itself — a different source having already sent a real alert for the
    # exact same rule+price within the window means this one is the "same"
    # real-world promotion, and must never notify again.
    already_grouped = evaluation.price_cents is not None and _already_notified_group_match_exists(
        session, rule.id, evaluation.price_cents, message.received_at, GROUPING_WINDOW
    )

    db_match = _persist_match(
        session,
        message,
        rule,
        evaluation.price_cents,
        price_cash_cents=evaluation.price_cash_cents,
        price_card_cents=evaluation.price_card_cents,
    )
    if db_match is None:
        return ProcessResult(match=None, deliveries_sent=0, reason="duplicate")

    increment_counter(session, MetricReason.SEEN, source_id=message.source_id)

    if already_grouped:
        for recipient in recipients:
            session.add(
                Delivery(
                    match_id=db_match.id,
                    recipient_id=recipient.id,
                    status=GROUPED_DELIVERY_STATUS,
                    delivered_at=None,
                )
            )
        session.flush()
        return ProcessResult(match=db_match, deliveries_sent=0)

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
                    link=build_message_link(source.chat_id, raw.id),
                    received_at=raw.date,
                )
                result = await process_message(
                    session, incoming, rule, source.recipients, notifier, dedupe_cache
                )
                session.commit()
                results.append(result)
    return results


async def initialize_new_source_cursor(
    session: Session,
    fetcher: RecentMessageFetcherProtocol,
    source_id: int,
    chat_id: str,
) -> None:
    """Set a brand-new source's cursor to the chat's current head, without
    notifying anything (S6-04).

    Only for a source with no persisted `ProcessingCursor` row yet
    (`packages.telegram.cursor.has_cursor` is `False`) — call this instead of
    `catch_up_since_cursor` for it at listener startup. That function treats
    every message `backfill_since_cursor` returns as "missed during a
    disconnect" and notifies for each match; a source that has simply never
    been live-processed before was never actually disconnected, so its whole
    recent history would be reported as a real, retroactive alert — exactly
    what S6-02's non-notifying `run_historical_scan` exists to surface
    instead. Idempotent: a chat with no messages at all leaves the cursor
    unset, and the next boot's `has_cursor` check is still `False`, so this
    simply runs again.
    """
    latest_id = await latest_message_id(fetcher, chat_id)
    if latest_id is not None:
        advance_cursor(session, source_id, latest_id)


@dataclass
class StartupResult:
    initialized: bool
    recovered: list[ProcessResult]


async def prepare_source_at_startup(
    session_factory: sessionmaker[Session],
    fetcher: ListenerFetcherProtocol,
    source: ListenerSource,
    notifier: BotNotifier,
    dedupe_cache: DedupeCache,
    *,
    max_messages: int = 100,
    max_age: timedelta | None = timedelta(hours=24),
) -> StartupResult:
    """One source's listener-boot handling (S6-04).

    A source with a cursor already persisted gets exactly the same notifying
    recovery a reconnect does (`catch_up_since_cursor`) — it really was
    live-processed before, so anything within the bound really was missed
    during this restart. A source with no cursor yet has never been
    live-processed at all, so nothing was actually "missed" there: its cursor
    is initialized at the chat's current head instead, with no notification.
    Never both for the same source. Either way, that source's historical-
    window (S13-05: 15 days by default) history still surfaces through S6-02's
    non-notifying `run_historical_scan` — this function never replaces that,
    only decides what the *notifying* startup path does.
    """
    with session_factory() as session:
        source_has_cursor = has_cursor(session, source.source_id)

    if not source_has_cursor:
        with session_factory() as session:
            await initialize_new_source_cursor(
                session, fetcher, source.source_id, source.chat_id
            )
            session.commit()
        return StartupResult(initialized=True, recovered=[])

    recovered = await catch_up_since_cursor(
        session_factory,
        fetcher,
        source,
        notifier,
        dedupe_cache,
        max_messages=max_messages,
        max_age=max_age,
    )
    return StartupResult(initialized=False, recovered=recovered)


async def process_historical_message(
    session: Session, message: IncomingMessage, rule: Rule, recipients: list[Recipient]
) -> ProcessResult:
    """Evaluate one historical message against `rule`, with no live side effect.

    S6-02: structurally cannot notify — there is no `BotNotifier` parameter to
    call, so a homologation scan of the historical window can never send a
    retroactive alert. Never advances `ProcessingCursor` and never touches a metric
    counter either (see `_evaluate_rule`). Applicable recipients still get a
    `Delivery` row, with `status="historical"` and `delivered_at=NULL`, so the
    panel can show "matched, no alert sent" instead of hiding the match.
    """
    evaluation = _evaluate_rule(rule, message.text)
    if evaluation.discard_reason is not None:
        return ProcessResult(match=None, deliveries_sent=0, reason=evaluation.discard_reason.value)

    db_match = _persist_match(
        session,
        message,
        rule,
        evaluation.price_cents,
        price_cash_cents=evaluation.price_cash_cents,
        price_card_cents=evaluation.price_card_cents,
    )
    if db_match is None:
        return ProcessResult(match=None, deliveries_sent=0, reason="duplicate")

    for recipient in recipients:
        session.add(
            Delivery(
                match_id=db_match.id,
                recipient_id=recipient.id,
                status=HISTORICAL_DELIVERY_STATUS,
                delivered_at=None,
            )
        )
    session.flush()

    return ProcessResult(match=db_match, deliveries_sent=0)


async def run_historical_scan(
    session_factory: sessionmaker[Session],
    fetcher: RecentMessageFetcherProtocol,
    source: ListenerSource,
    *,
    window: timedelta = HISTORICAL_WINDOW,
    before: datetime,
) -> list[ProcessResult]:
    """Reevaluate `source`'s last `window` of messages against every active rule.

    Default window is `HISTORICAL_WINDOW`, 15 days (S13-05; 7 days since S7-04,
    24h in S6-02's first homologation pass) — unrelated to `catch_up_since_cursor`'s own
    `max_age` (still 24h), which bounds a *reconnect*'s gap, not how far back
    a fresh source's first historical scan looks.

    S6-02: independent of `ProcessingCursor`/the live reconnect path — never
    reads or advances it — and safe to repeat on every listener startup, since
    `_persist_match`'s identity check (S6-01) makes a second scan a no-op with
    a fresh process, a fresh session, and no cache of its own.

    `before` must be captured by the caller *after* the live handler is
    already registered (see `packages.telegram.historical.fetch_messages_since`)
    so a message that arrives while this scan is still running is always the
    live handler's alert to send, never re-classified as historical.
    """
    recent = await fetch_messages_since(fetcher, source.chat_id, window=window, before=before)

    results: list[ProcessResult] = []
    for raw in recent:
        for rule in source.rules:
            with session_factory() as session:
                incoming = IncomingMessage(
                    source_id=source.source_id,
                    message_id=raw.id,
                    text=raw.text,
                    link=build_message_link(source.chat_id, raw.id),
                    received_at=raw.date,
                )
                result = await process_historical_message(
                    session, incoming, rule, source.recipients
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
        "matched_at": format_utc(result.match.matched_at),
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
