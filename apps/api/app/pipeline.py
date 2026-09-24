from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Protocol

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, sessionmaker

from app.delivery_policy import is_snoozed
from app.digest_settings import load_digest_settings
from app.feed_settings import get_group_duplicates
from app.product_history import posting_identity
from app.utc import ensure_utc, format_utc
from models import Delivery, Match, Recipient, Rule, Source
from packages.events.broker import EventBroker
from packages.metrics.counters import MetricReason, increment_counter
from packages.notifications.bot import BotNotifier
from packages.notifications.formatting import format_price_cents
from packages.rules.dedupe import DedupeCache, compute_signature
from packages.rules.match import MatchRule
from packages.rules.normalize import normalize_text
from packages.rules.price import extract_price
from packages.rules.product import product_key
from packages.rules.target import target_hit
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
# S14-02: the two delivery channels a match can go out through. Almost every
# match still gets exactly one `Delivery` row per recipient tagged with
# whichever kind `decide_delivery_kind` picked; the one exception is a match
# that is both grouped (S7-11) and a target hit, which needs the suppressed
# `DELIVERY_KIND_IMMEDIATE` bookkeeping row *and* a real
# `DELIVERY_KIND_TARGET` send — see `process_message` below.
DELIVERY_KIND_IMMEDIATE = "immediate"
DELIVERY_KIND_TARGET = "target"
# S14-06 (F7): a third channel, used only by `app.routers.matches`'s
# `PATCH /matches/{id}` — a manually-corrected price that lands at or below
# the rule's target fires this once, the same idempotency shape as
# `DELIVERY_KIND_TARGET` (the `(match_id, recipient_id, kind)` unique
# constraint on `delivery`), just never reachable from `process_message`.
DELIVERY_KIND_MANUAL_TARGET = "manual_target"
# S14-04: another channel — a common match held back for the once-a-day
# digest instead of notifying now. Only ever chosen *after* `decide_delivery_
# kind` already picked `DELIVERY_KIND_IMMEDIATE` (a target hit never digests,
# Gabriel's decision carried over from S14-02/S14-03: it always pierces both
# snooze and digest) — see the `digest_settings.enabled and mute_individual`
# branch in `process_message` below. `app.digest.run_digest_once` is the only
# place a "pending" digest delivery ever becomes "sent" or `DIGEST_SKIPPED_
# DELIVERY_STATUS`.
DELIVERY_KIND_DIGEST = "digest"
# S14-04: a digest delivery `top_n` cut past — marked explicitly rather than
# left "pending" forever, so `GET /digest`'s queue count (and any future
# "matches pendentes há muito tempo" alert) never counts an item that will
# never be sent as still waiting.
DIGEST_SKIPPED_DELIVERY_STATUS = "digest_skipped"
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
    # S14-02: whether this match's delivery went out through the prioritized
    # target channel (`DELIVERY_KIND_TARGET`) rather than the plain one.
    # `False` for a discard/duplicate (no match at all) and for every match
    # whose rule has no target or whose price didn't reach it.
    target_hit: bool = False


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


def evaluate_rule(rule: Rule, text: str) -> RuleEvaluation:
    """Match -> price, with no side effect of its own.

    Shared by the live path, the historical path (S6-02) and the dry-run
    `POST /rules/test` (S13-07) precisely so none of them duplicates the
    matching/pricing logic — they differ only in what happens *after* this:
    the live path counts discards/matches and notifies, the historical path
    never touches a metric counter at all (a homologation scan of the
    historical window must not inflate the counters that describe live
    traffic health, and would double-count on every listener restart if it
    did, since `MetricCounter` is cumulative, not deduplicated by identity),
    and the dry-run test endpoint never persists or counts anything at all.
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
        product_key=product_key(message.text),
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
    *,
    kind: str,
) -> bool:
    """S7-11/S14-02: whether some other `Match` (any source) for the same
    rule and the exact same price, within `window` of `matched_at`, already
    has a real successful send *of the given `kind`* — never
    `"historical"`/`"grouped"`/`"failed"`/etc., only the literal `"sent"`
    status `process_message` uses below. Safe to compare live against what's
    already committed in the database precisely because live events arrive
    in real chronological order (unlike the historical scan, S6-02) — no
    risk of a later message actually being the earlier one.

    `kind` is filtered explicitly (S14-02) so the two channels never bleed
    into each other's grouping: a plain repeat is only ever suppressed by an
    earlier plain send, and a target-hit repeat is only ever suppressed by an
    earlier *target* send — otherwise a target hit sent once as the group's
    first `"immediate"` alert (before Gabriel set a target) would wrongly
    suppress every future target alert for that same price, and conversely a
    later plain match wouldn't be suppressed by an earlier target send at the
    same price. `process_message` below calls this once per channel.

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
            Delivery.kind == kind,
        )
        .limit(1)
    )
    return session.scalar(exists_stmt) is not None


def _already_queued_or_sent_digest_group_exists(
    session: Session,
    rule_id: int,
    price_cents: int,
    matched_at: datetime,
    window: timedelta,
) -> bool:
    """S14-04: the digest-channel sibling of `_already_notified_group_match_
    exists` above — same rule/price/window grouping, but a *repeat* only
    needs a `Delivery` already queued for the digest (`"pending"`) or already
    sent by a past run (`"sent"`) to count, not only a real send. A repeat of
    the same real-world promotion must stay grouped in the digest queue too
    (S14-04 decision), never adding a second line item for one offer.

    Deliberately excludes `"grouped"`/`"digest_skipped"`/`"failed"` rows for
    the same reason the immediate channel's own check does: only a state that
    genuinely represents "this promotion is already accounted for" anchors
    the window, never a row that was itself already suppressed by this same
    check on an earlier match.
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
            Delivery.kind == DELIVERY_KIND_DIGEST,
            Delivery.status.in_(("pending", "sent")),
        )
        .limit(1)
    )
    return session.scalar(exists_stmt) is not None


def decide_delivery_kind(rule: Rule, price_cents: int | None) -> str:
    """S14-02: the single point that decides which channel a match's alert
    uses — `process_message` below is the only caller today, and S14-03
    (snooze) and S14-04 (digest) must both call this too, before deciding
    whether to hold a delivery back. A target hit always wins: it ignores the
    digest and pierces an active snooze (Gabriel, 2026-09-23), while every
    `DELIVERY_KIND_IMMEDIATE` delivery stays subject to both. Keeping the
    decision itself in one small function is what makes that guarantee
    checkable in one place instead of re-derived at each call site.
    """
    if target_hit(price_cents, rule.target_price_cents):
        return DELIVERY_KIND_TARGET
    return DELIVERY_KIND_IMMEDIATE


def build_target_alert_text(text: str, rule: Rule, price_cents: int) -> str:
    """The target-hit message: a distinct, prioritized shape (🎯 prefix) so
    it reads differently in Telegram from a plain match, per the tela 09
    spec. Called after `decide_delivery_kind` picked `DELIVERY_KIND_TARGET`,
    and also by `app.routers.matches` for `DELIVERY_KIND_MANUAL_TARGET`
    (S14-06) — both callers already guarantee `rule.target_price_cents` is
    set before reaching here.
    """
    assert rule.target_price_cents is not None
    return (
        f"🎯 Alvo atingido! Abaixo do alvo de {format_price_cents(rule.target_price_cents)}"
        f" (preço atual {format_price_cents(price_cents)}).\n\n{text}"
    )


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

    evaluation = evaluate_rule(rule, message.text)
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

    # S14-02: computed before `kind` is known below only insofar as it needs
    # `evaluation.price_cents`/`rule` — both already available, so `kind`
    # itself is decided here too, before persisting, to drive the
    # kind-filtered grouping check right after it.
    kind = decide_delivery_kind(rule, evaluation.price_cents)
    is_target = kind == DELIVERY_KIND_TARGET

    # S7-11/S14-02: computed before persisting this match, so it can never
    # see itself — a different source having already sent a real alert of
    # the *same channel* for the exact same rule+price within the window
    # means this one is the "same" real-world promotion on that channel, and
    # must never notify again through it. Filtered by `kind` (see
    # `_already_notified_group_match_exists`) so a target hit is only ever
    # suppressed by an earlier target send, never by an earlier plain one.
    already_grouped = evaluation.price_cents is not None and _already_notified_group_match_exists(
        session, rule.id, evaluation.price_cents, message.received_at, GROUPING_WINDOW, kind=kind
    )
    # S14-02: for a target hit only, also check the *plain* channel's own
    # grouping — purely for audit-trail parity (see the bookkeeping row
    # below); it never affects whether the target alert itself is sent.
    already_grouped_immediate = is_target and (
        evaluation.price_cents is not None
        and _already_notified_group_match_exists(
            session,
            rule.id,
            evaluation.price_cents,
            message.received_at,
            GROUPING_WINDOW,
            kind=DELIVERY_KIND_IMMEDIATE,
        )
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

    # S14-03 (F3): silencing only ever suppresses the delivery below — the
    # match is already persisted above and the caller still publishes it on
    # SSE (`build_match_event` only checks `result.match`), exactly as if
    # nothing were snoozed. S14-02: a target hit ignores this entirely —
    # `is_snoozed`'s own `target_hit` parameter always returns `False` for
    # one, Gabriel's decision (2026-09-23) that a price target fires through
    # any active snooze.
    if is_snoozed(
        session,
        rule_id=rule.id,
        product_key=db_match.product_key,
        now=message.received_at,
        target_hit=is_target,
    ):
        return ProcessResult(match=db_match, deliveries_sent=0, reason="snoozed")

    if not is_target and already_grouped:
        for recipient in recipients:
            session.add(
                Delivery(
                    match_id=db_match.id,
                    recipient_id=recipient.id,
                    kind=DELIVERY_KIND_IMMEDIATE,
                    status=GROUPED_DELIVERY_STATUS,
                    delivered_at=None,
                )
            )
        session.flush()
        return ProcessResult(match=db_match, deliveries_sent=0)

    if is_target and already_grouped:
        # S14-02 (Tech Lead fix): a repeat of the *same target group* (same
        # rule, same price, within the window) as one already really sent on
        # the target channel must not alert again — the first posting of a
        # price already pinged Gabriel; the same offer showing up in two more
        # groups afterwards is not three separate reasons to ping him. Unlike
        # the plain channel's grouped branch above, this can only be reached
        # once `already_grouped` was computed against `kind=target` (see
        # `_already_notified_group_match_exists`), so it never fires on a
        # plain send from before the target existed.
        for recipient in recipients:
            session.add(
                Delivery(
                    match_id=db_match.id,
                    recipient_id=recipient.id,
                    kind=DELIVERY_KIND_TARGET,
                    status=GROUPED_DELIVERY_STATUS,
                    delivered_at=None,
                )
            )
        session.flush()
        return ProcessResult(match=db_match, deliveries_sent=0, target_hit=True)

    if is_target and already_grouped_immediate:
        # S14-02: the plain channel would have suppressed this exact match as
        # a repeat (S7-11) — recorded here for the same audit trail every
        # other branch gets — but the target channel below still fires: a
        # target hit ignores that suppression (Gabriel, 2026-09-23). This is
        # a *different* group than the one just checked above (no earlier
        # target send yet for this price, only an earlier plain one — e.g.
        # Gabriel set the target after the first posting already went out as
        # a plain alert), so it falls through to send.
        for recipient in recipients:
            session.add(
                Delivery(
                    match_id=db_match.id,
                    recipient_id=recipient.id,
                    kind=DELIVERY_KIND_IMMEDIATE,
                    status=GROUPED_DELIVERY_STATUS,
                    delivered_at=None,
                )
            )

    # S14-04: a common match held back for the digest instead of notified now
    # — only ever reachable here, never for a target hit (`is_target` always
    # falls through to the notify loop below, piercing both snooze above and
    # the digest here, Gabriel's decision carried over from S14-02/S14-03).
    # `mute_individual` off keeps today's behavior unchanged even with the
    # digest otherwise configured/enabled: only turning both on redirects a
    # common match away from immediate delivery.
    if not is_target:
        digest_settings = load_digest_settings(session)
        if digest_settings.enabled and digest_settings.mute_individual:
            digest_grouped = (
                evaluation.price_cents is not None
                and _already_queued_or_sent_digest_group_exists(
                    session, rule.id, evaluation.price_cents, message.received_at, GROUPING_WINDOW
                )
            )
            digest_status = GROUPED_DELIVERY_STATUS if digest_grouped else "pending"
            for recipient in recipients:
                session.add(
                    Delivery(
                        match_id=db_match.id,
                        recipient_id=recipient.id,
                        kind=DELIVERY_KIND_DIGEST,
                        status=digest_status,
                        delivered_at=None,
                    )
                )
            session.flush()
            return ProcessResult(match=db_match, deliveries_sent=0)

    notify_text = message.text
    if is_target:
        assert evaluation.price_cents is not None  # decide_delivery_kind guarantees this
        notify_text = build_target_alert_text(message.text, rule, evaluation.price_cents)

    deliveries_sent = 0
    for recipient in recipients:
        try:
            result = await notifier.notify(
                match_id=db_match.id,
                recipient_id=recipient.id,
                chat_id=recipient.telegram_chat_id,
                text=notify_text,
            )
        except Exception:  # one recipient's delivery failure must not sink the whole batch
            increment_counter(session, MetricReason.DELIVERY_FAILURE, source_id=message.source_id)
            session.add(
                Delivery(
                    match_id=db_match.id, recipient_id=recipient.id, kind=kind, status="failed"
                )
            )
            continue

        if result.delivered:
            deliveries_sent += 1

        session.add(
            Delivery(
                match_id=db_match.id,
                recipient_id=recipient.id,
                kind=kind,
                status="sent" if result.delivered else (result.reason or "skipped"),
                delivered_at=datetime.now(UTC) if result.delivered else None,
            )
        )

    session.flush()

    return ProcessResult(match=db_match, deliveries_sent=deliveries_sent, target_hit=is_target)


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
    counter either (see `evaluate_rule`). Applicable recipients still get a
    `Delivery` row, with `status="historical"` and `delivered_at=NULL`, so the
    panel can show "matched, no alert sent" instead of hiding the match.
    """
    evaluation = evaluate_rule(rule, message.text)
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


_GROUP_KEY_EPOCH = datetime(1970, 1, 1, tzinfo=UTC)


def compute_group_key(
    product_key: str | None, price_cents: int | None, matched_at: datetime
) -> str | None:
    """S14-05 (F5): a deterministic key correlating a live `match` SSE event
    with the feed card it belongs to, so the UI can update that card instead
    of appending a duplicate one. `None` whenever there is nothing to group
    on (`product_key` unset, or no extracted price).

    Built from `product_key` + `price_cents` + the start of the
    `GROUPING_WINDOW`-sized bucket `matched_at` falls into, floored against a
    fixed UTC epoch so every process (listener, api) computes the exact same
    boundaries without coordinating and without a database round trip here.

    This is only ever a hint for the live UI to avoid an obvious duplicate;
    the feed's own read-time grouping (`app.routers.matches`, same
    `product_key`/`price_cents` key) is the actual source of truth for what
    gets shown, because it walks real chronological neighbours instead of
    fixed buckets. Two matches within `GROUPING_WINDOW` of each other but
    straddling a bucket boundary get two different keys here — a known,
    documented limitation of a stateless key, not a bug: the next feed
    reload always shows the correct, fully-merged card regardless.
    """
    if product_key is None or price_cents is None:
        return None
    aware = ensure_utc(matched_at)
    bucket_index = (aware - _GROUP_KEY_EPOCH) // GROUPING_WINDOW
    bucket_start = _GROUP_KEY_EPOCH + bucket_index * GROUPING_WINDOW
    return f"{product_key}:{price_cents}:{format_utc(bucket_start)}"


def _grouped_summary(session: Session, db_match: Match) -> dict[str, Any] | None:
    """S14-05 (F5): the `seen_count`/`sources` of the duplicate group
    `db_match` lands in, once it is included — lets the live UI update that
    existing feed card instead of appending a duplicate one. Keyed on the
    same `product_key` + `price_cents` + `compute_group_key` bucket as
    `group_key` itself: a hint, not the source of truth (that stays
    `app.routers.matches`' own chronological-neighbour grouping), so this
    never needs to walk the whole table.

    `None` when there is nothing to fold into (no `product_key`/price, this
    is the bucket's first sighting, or the sighting is the same Telegram
    message caught by a second rule) or the "Agrupar duplicatas" toggle is
    off. One query, never one per candidate.
    """
    if db_match.product_key is None or db_match.price_cents is None:
        return None
    if not get_group_duplicates(session):
        return None

    aware = ensure_utc(db_match.matched_at)
    bucket_index = (aware - _GROUP_KEY_EPOCH) // GROUPING_WINDOW
    bucket_start = _GROUP_KEY_EPOCH + bucket_index * GROUPING_WINDOW
    bucket_end = bucket_start + GROUPING_WINDOW

    rows = session.execute(
        select(Match.id, Match.source_id, Match.telegram_message_id, Source.name)
        .join(Source, Source.id == Match.source_id)
        .where(
            Match.product_key == db_match.product_key,
            Match.price_cents == db_match.price_cents,
            Match.matched_at >= bucket_start,
            Match.matched_at < bucket_end,
        )
        .order_by(Match.id)
    ).all()

    identities = {posting_identity(row.id, row.source_id, row.telegram_message_id) for row in rows}
    if len(identities) < 2:
        return None

    ordered_source_ids: list[int] = []
    names: dict[int, str] = {}
    for row in rows:
        names[row.source_id] = row.name
        if row.source_id not in ordered_source_ids:
            ordered_source_ids.append(row.source_id)

    return {
        "seen_count": len(identities),
        "sources": [
            {"id": source_id, "name": names[source_id]} for source_id in ordered_source_ids
        ],
    }


def build_match_event(
    result: ProcessResult, session: Session | None = None
) -> dict[str, Any] | None:
    """Build the `match` SSE payload for a `ProcessResult`, or `None` if it was a discard.

    `session`, when given, also computes `grouped_summary` (S14-05 F5) so a
    live event that lands inside an already-existing duplicate group carries
    that group's `seen_count`/`sources`, letting the UI update the existing
    card instead of appending a duplicate one — `None` without a session
    (existing callers) or when this match does not actually join a group.
    """
    if result.match is None:
        return None
    return {
        "match_id": result.match.id,
        "source_id": result.match.source_id,
        "rule_id": result.match.rule_id,
        "price_cents": result.match.price_cents,
        "product_key": result.match.product_key,
        "message_link": result.match.message_link,
        "matched_at": format_utc(result.match.matched_at),
        "deliveries_sent": result.deliveries_sent,
        # S14-02: whether this match's alert went out through the
        # prioritized target channel — computed once in `process_message`,
        # not re-derived here.
        "target_hit": result.target_hit,
        # S14-05 (F5): lets the live UI fold this event into an existing
        # feed card instead of duplicating it — see `compute_group_key`.
        "group_key": compute_group_key(
            result.match.product_key, result.match.price_cents, result.match.matched_at
        ),
        "grouped_summary": _grouped_summary(session, result.match) if session is not None else None,
    }


def publish_match_event(
    broker: EventBroker, result: ProcessResult, session: Session | None = None
) -> None:
    """Publish the `match` SSE event for a `ProcessResult`.

    Call this only after the caller's `session.commit()` has succeeded — a match
    must never reach the live feed before it is durably persisted. `session`
    is optional and only used to compute `grouped_summary` (S14-05 F5); pass
    the same session already committed above — reading after a commit is safe.
    """
    event = build_match_event(result, session)
    if event is not None:
        broker.publish("match", event)
