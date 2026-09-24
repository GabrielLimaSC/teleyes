from datetime import UTC, datetime
from typing import Any, Literal
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import ScalarSelect, Select, and_, exists, func, or_, select
from sqlalchemy.orm import Session, aliased

from app.feed_settings import get_group_duplicates
from app.main import get_current_session, get_db, require_csrf
from app.pipeline import (
    DELIVERY_KIND_MANUAL_TARGET,
    GROUPING_WINDOW,
    build_target_alert_text,
    compute_group_key,
)
from app.product_history import get_display_timezone, posting_identity, sparklines_for_keys
from app.routers.notifications import BotNotifierFactory, get_bot_notifier_factory
from app.routers.products import PricePointResponse
from app.utc import UtcDatetime, utc_now
from auth.session import SessionRecord
from models import Delivery, Match, MatchCorrection, Recipient, Rule, Snooze, Source
from packages.rules.manual_price import PriceParseError, parse_manual_price_cents
from packages.rules.target import target_gap_pct, target_hit

router = APIRouter(
    prefix="/matches",
    tags=["matches"],
    dependencies=[Depends(get_current_session)],
)


class DeliveryResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    recipient_id: int
    status: str
    delivered_at: UtcDatetime | None
    created_at: UtcDatetime


class MatchSourceResponse(BaseModel):
    """S14-05 (F5): one distinct source of a duplicate group, in the order it
    first posted.
    """

    id: int
    name: str


class MatchCorrectionResponse(BaseModel):
    """S14-06 (F7): who last edited/reverted a match, and when — tela 08's
    "última correção" line. `changes` itself is audit-only and never leaves
    this endpoint's own history (not exposed here).
    """

    admin_id: int
    created_at: UtcDatetime


class MatchResponse(BaseModel):
    id: int
    source_id: int
    rule_id: int
    message_text: str
    price_cents: int | None
    # S7-05: only ever both set together, when packages.rules.price found two
    # explicit, distinct textual anchors — null/null for every other match,
    # same as always.
    price_cash_cents: int | None
    price_card_cents: int | None
    message_link: str | None
    matched_at: UtcDatetime
    created_at: UtcDatetime
    deliveries: list[DeliveryResponse]
    is_lowest_price_ever: bool
    # S7-11 mechanism 2: other sources' ids that posted this same rule+price
    # within GROUPING_WINDOW of this match (chained, so a longer spread-out
    # sequence still collapses into one card) — None when nothing grouped
    # with it. Purely a read-time presentation grouping: every Match row
    # still exists and is unaffected, this only decides which one is the
    # representative card and which ones are folded into it.
    grouped_source_ids: list[int] | None = None
    # S14-01: `packages.rules.product.product_key` of the message (null when
    # no product title was recognised) and a short 90-day lowest-price-per-day
    # series of that product (at most 30 points, oldest first; empty when the
    # product has no priced match in the window). Aggregated for the whole
    # response in a single query, never one per item.
    product_key: str | None = None
    sparkline: list[PricePointResponse] = []
    # S14-03: the rule or the product (whichever this match has) is silenced
    # right now — the card shows "Reativar" instead of the usual actions.
    # Computed fresh on every read from `snooze`, same reasoning as every
    # other on-read flag in this file.
    snoozed: bool = False
    # S14-02 (F6): the match's rule's price target, and whether/how close this
    # match's own price is to it. `target_price_cents` mirrors `Rule.
    # target_price_cents` (null without one); `target_hit` and
    # `target_gap_pct` are computed fresh on every read from those two plus
    # `price_cents` (`packages.rules.target`), never persisted — same
    # reasoning as `is_lowest_price_ever` above. Items with `target_hit` sort
    # first in this endpoint's response (see `list_matches`).
    target_price_cents: int | None = None
    target_hit: bool = False
    target_gap_pct: int | None = None
    # S14-05 (F5): "Visto em N fontes" — set only on the representative of a
    # duplicate group (`_apply_duplicate_grouping`), distinct postings of the
    # same `product_key` at the same price within `GROUPING_WINDOW`, deduped
    # by `posting_identity` (a message caught by two rules is one sighting).
    # `1` and the item's own id/no sources for a card that groups with
    # nothing, including whenever the "Agrupar duplicatas" toggle is off.
    seen_count: int = 1
    sources: list[MatchSourceResponse] = []
    # Always at least the item's own id, even for a card that groups with
    # nothing (including whenever the toggle is off) — every match id this
    # card stands for, representative included.
    grouped_match_ids: list[int] = []
    # S14-05: deterministic key for the live UI to fold a `match` SSE event
    # into this same card instead of duplicating it — see
    # `app.pipeline.compute_group_key`. `None` exactly when `product_key` or
    # `price_cents` is `None`. Set on every item regardless of the "Agrupar
    # duplicatas" toggle, since the live UI needs it to recognise a fold
    # target even for a card the toggle currently shows standalone.
    group_key: str | None = None
    # Not part of the public response — carried only so `_apply_duplicate_grouping`
    # can dedupe "the same message, caught by two rules" via `posting_identity`
    # without a second query.
    telegram_message_id: int | None = Field(default=None, exclude=True)
    # S14-06 (F7): manual product edit fields. `display_name` takes priority
    # over the parsed title wherever the panel shows one, including on the
    # representative card of a duplicate group (S14-05) above — grouping only
    # ever folds *other* matches into a representative's own response, it
    # never merges or overrides that representative's own fields, so the
    # representative's `display_name` (its own, never a hidden sibling's) is
    # exactly what a grouped card shows. `price_source` feeds the "editado
    # manualmente" chip (`"manual"` right after an edit, `"parsed"` again
    # once "Reverter ao detectado" runs, `None` for a match never touched).
    # `original_price_cents` is the price
    # `packages.rules.price.extract_price` first found, kept for the
    # "Reverter" action regardless of how many manual edits followed.
    display_name: str | None = None
    model_variant: str | None = None
    price_source: Literal["parsed", "manual"] | None = None
    original_price_cents: int | None = None
    last_correction: MatchCorrectionResponse | None = None


def _target_price_cents_per_rule() -> ScalarSelect[int | None]:
    """Scalar subquery: the outer `Match` row's rule's `target_price_cents`.

    A correlated subquery rather than a join to `Rule`, on purpose: `Match.
    rule_id` has no DB-level cascade (`repositories.rule_repo.delete_rule`
    never touches its matches), so a rule can be deleted while its matches
    live on. A join would silently drop such a match from the feed; this
    subquery just yields `NULL` for it, same as a match with no rule at all
    would read as "no target" — never an outright disappearance.
    """
    rule = aliased(Rule)
    return (
        select(rule.target_price_cents)
        .where(rule.id == Match.rule_id)
        .correlate(Match)
        .scalar_subquery()
    )


def _lowest_price_cents_per_rule() -> ScalarSelect[int | None]:
    """Scalar subquery: the true historical minimum `price_cents` for the
    same rule as the outer `Match` row, `NULL` if that rule has no priced
    match at all (S7-06).

    Computed on every read, correlated into the same single query
    `list_matches` already runs — never persisted on `Match` at insert time.
    A historical scan (S6-02) processes a source's messages newest-to-oldest,
    so "the minimum so far" at insert time would not reflect real
    chronological order and could flag a stale/wrong match as the record;
    computing it fresh on every read is always correct and never needs a
    backfill when an even cheaper match is inserted later, live or
    historical.
    """
    lowest = aliased(Match)
    return (
        select(func.min(lowest.price_cents))
        .where(lowest.rule_id == Match.rule_id, lowest.price_cents.is_not(None))
        .correlate(Match)
        .scalar_subquery()
    )


def _snoozed_now(now: datetime) -> Any:
    """S14-03: `EXISTS` scalar subquery, correlated into the same single query
    `list_matches` already runs — never a second round trip, same reasoning
    as `_lowest_price_cents_per_rule` above. Active means `until > now`,
    matched by the row's own rule or, when it has one, its product.
    """
    return exists(
        select(Snooze.id)
        .where(
            Snooze.until > now,
            or_(
                and_(Snooze.scope == "rule", Snooze.rule_id == Match.rule_id),
                and_(Snooze.scope == "product", Snooze.product_key == Match.product_key),
            ),
        )
        .correlate(Match)
    )


def _latest_correction_admin_id() -> Any:
    """S14-06: scalar subquery, the `admin_id` of the outer `Match` row's most
    recent `MatchCorrection` (highest `id`, which tracks insertion order the
    same way `Delivery`/`Match` ordering already does elsewhere in this
    file) — `NULL` for a match never edited or reverted. Paired with
    `_latest_correction_created_at` below rather than joined-and-grouped, so
    both stay simple correlated subqueries like every other per-row
    computation in `list_matches`.
    """
    correction = aliased(MatchCorrection)
    return (
        select(correction.admin_id)
        .where(correction.match_id == Match.id)
        .order_by(correction.id.desc())
        .limit(1)
        .correlate(Match)
        .scalar_subquery()
    )


def _latest_correction_created_at() -> Any:
    """S14-06: the `created_at` half of `_latest_correction_admin_id` above —
    same row, same ordering, kept as its own subquery because a scalar
    subquery can only project one column.
    """
    correction = aliased(MatchCorrection)
    return (
        select(correction.created_at)
        .where(correction.match_id == Match.id)
        .order_by(correction.id.desc())
        .limit(1)
        .correlate(Match)
        .scalar_subquery()
    )


def _match_filters(
    statement: Select[tuple[Match, Delivery, int | None, int | None]],
    *,
    rule_id: int | None,
    source_id: int | None,
    recipient_id: int | None,
    price_cents: int | None,
    min_price_cents: int | None,
    max_price_cents: int | None,
    delivery_status: str | None,
) -> Select[tuple[Match, Delivery, int | None, int | None]]:
    if rule_id is not None:
        statement = statement.where(Match.rule_id == rule_id)
    if source_id is not None:
        statement = statement.where(Match.source_id == source_id)
    if price_cents is not None:
        statement = statement.where(Match.price_cents == price_cents)
    if min_price_cents is not None:
        statement = statement.where(Match.price_cents >= min_price_cents)
    if max_price_cents is not None:
        statement = statement.where(Match.price_cents <= max_price_cents)

    if recipient_id is not None or delivery_status is not None:
        delivery_filter = (
            select(Delivery.id)
            .where(Delivery.match_id == Match.id)
            .correlate(Match)
        )
        if recipient_id is not None:
            delivery_filter = delivery_filter.where(Delivery.recipient_id == recipient_id)
        if delivery_status is not None:
            delivery_filter = delivery_filter.where(Delivery.status == delivery_status)
        statement = statement.where(exists(delivery_filter))

    return statement


MatchSort = Literal["price_asc", "price_desc"]


def _order_by(sort: MatchSort | None) -> list[Any]:
    """S7-07: ranks matches by price within (typically) a single filtered
    rule. `Match.matched_at.desc()` (S10-03: real chronological order, not
    insertion order — see below) is the default and the tiebreaker for a
    price tie, with `Match.id.desc()` as the final tiebreaker for the rare
    case of two matches sharing the exact same `matched_at` (real production
    example: two different messages processed in the same historical-scan
    batch). `nulls_last()` keeps a match with no extracted price at the
    bottom regardless of direction, since SQLite would otherwise sort NULL
    before every value in `price_asc` (the opposite of what "ascending"
    should mean for a price list a human is scanning).

    S10-03: this used to be `Match.id.desc()` alone, which quietly assumed
    insertion order tracks chronological order — true only until the first
    listener restart after S6-02, whose historical re-scan inserts matches
    from old messages out of order every time it runs. Confirmed against
    real production data: zero correlation between `id` and `matched_at`
    after a few restarts. `_apply_display_grouping` below reads `matched_at`
    directly for its own grouping decisions (never the SQL row order), so
    this is the only place "recency" was ever actually determined by `id`.
    """
    if sort == "price_asc":
        return [
            Match.price_cents.asc().nulls_last(),
            Match.matched_at.desc(),
            Match.id.desc(),
            Delivery.id,
        ]
    if sort == "price_desc":
        return [
            Match.price_cents.desc().nulls_last(),
            Match.matched_at.desc(),
            Match.id.desc(),
            Delivery.id,
        ]
    return [Match.matched_at.desc(), Match.id.desc(), Delivery.id]


def _attach_group(chain: list[MatchResponse], hidden_ids: set[int]) -> None:
    """A chain of 2+ chronologically-consecutive same-rule/same-price matches
    collapses into one card. The representative prefers a member that
    actually sent a real alert (`Delivery.status == "sent"`) over one that
    merely arrived first chronologically — otherwise an older match with no
    real alert (e.g. `historical`, S6-02) could become the representative
    and hide a sibling that genuinely notified Gabriel's phone, showing a
    dishonest status for the whole group. Falls back to the earliest
    `matched_at` when no member ever sent a real alert; a tie among several
    "sent" members (shouldn't happen given mechanism 1 in `app.pipeline`,
    kept here only as a safety net) also resolves to the earliest.
    `grouped_source_ids` gets every other member's distinct `source_id`) and
    the rest are hidden from the returned list — their `Match`/`Delivery`
    rows are untouched, only excluded from this response.
    """
    if len(chain) < 2:
        return
    def _sent(member: MatchResponse) -> bool:
        return any(delivery.status == "sent" for delivery in member.deliveries)

    sent_members = [member for member in chain if _sent(member)]
    candidates = sent_members if sent_members else chain
    representative = min(candidates, key=lambda member: member.matched_at)
    others = [member for member in chain if member.id != representative.id]
    other_source_ids = sorted({member.source_id for member in others} - {representative.source_id})
    if other_source_ids:
        representative.grouped_source_ids = other_source_ids
    for member in others:
        hidden_ids.add(member.id)


def _apply_display_grouping(matches: dict[int, MatchResponse]) -> list[MatchResponse]:
    """S7-11 mechanism 2: collapses same rule+price matches into one card at
    read time, independent of insertion order. `process_message`'s own check
    (mechanism 1, in `app.pipeline`) only ever compares against a match it
    can already see, so it misses two known cases: a historical scan
    inserting matches out of chronological order, and a chain spread out
    past `GROUPING_WINDOW` from its own first link but with each consecutive
    pair still close together. Grouping fresh on every read, from
    `matched_at`, fixes both without ever touching what was persisted.
    """
    groups: dict[tuple[int, int], list[MatchResponse]] = {}
    for response in matches.values():
        if response.price_cents is None:
            continue
        groups.setdefault((response.rule_id, response.price_cents), []).append(response)

    hidden_ids: set[int] = set()
    for members in groups.values():
        if len(members) < 2:
            continue
        members.sort(key=lambda response: response.matched_at)
        chain = [members[0]]
        for candidate in members[1:]:
            if candidate.matched_at - chain[-1].matched_at <= GROUPING_WINDOW:
                chain.append(candidate)
                continue
            _attach_group(chain, hidden_ids)
            chain = [candidate]
        _attach_group(chain, hidden_ids)

    return [response for response in matches.values() if response.id not in hidden_ids]


def _attach_duplicate_group(
    chain: list[MatchResponse], source_names: dict[int, str], hidden_ids: set[int]
) -> None:
    """`chain` is 2+ same-`product_key`/same-price matches, already sorted
    earliest-first and chronologically consecutive within `GROUPING_WINDOW`
    (see `_apply_duplicate_grouping`). Deduped first by `posting_identity` —
    the same Telegram message caught by two rules is one sighting, not two,
    and must not turn a lone posting into a fake "duplicate" group.
    """
    identities = {
        posting_identity(member.id, member.source_id, member.telegram_message_id)
        for member in chain
    }
    if len(identities) < 2:
        return

    representative, *others = chain
    ordered_source_ids: list[int] = []
    for member in chain:
        if member.source_id not in ordered_source_ids:
            ordered_source_ids.append(member.source_id)

    representative.seen_count = len(identities)
    representative.sources = [
        MatchSourceResponse(id=source_id, name=source_names.get(source_id, f"#{source_id}"))
        for source_id in ordered_source_ids
    ]
    representative.grouped_match_ids = sorted(member.id for member in chain)
    for member in others:
        hidden_ids.add(member.id)


def _apply_duplicate_grouping(db: Session, visible: list[MatchResponse]) -> list[MatchResponse]:
    """S14-05 (F5): "Visto em N fontes" — folds distinct sources posting the
    same `product_key` at the same price within `GROUPING_WINDOW` into one
    card, at read time, on top of `visible` (already run through the S7-11
    rule-based grouping above; the two mechanisms key on different things —
    `rule_id` there, `product_key` here — and compose cleanly since a match
    hidden by one never needs a second look from the other). No `Match`
    row is ever touched: only this response list changes shape.

    A no-op — every match keeps its own card — whenever the "Agrupar
    duplicatas" toggle (`app.feed_settings`) is off. That toggle, and the
    source names below, are only ever read once a real 2+ chain is found:
    a request with nothing to group (no `product_key`, or every product/price
    combination a singleton — e.g. `test_matches_list_includes_deliveries_
    without_n_plus_one`) costs zero extra queries, never one per request
    regardless of grouping candidates (no N+1).
    """
    groups: dict[tuple[str, int], list[MatchResponse]] = {}
    for response in visible:
        if response.product_key is None or response.price_cents is None:
            continue
        groups.setdefault((response.product_key, response.price_cents), []).append(response)

    chains: list[list[MatchResponse]] = []
    for members in groups.values():
        if len(members) < 2:
            continue
        members.sort(key=lambda response: (response.matched_at, response.id))
        chain = [members[0]]
        for candidate in members[1:]:
            if candidate.matched_at - chain[-1].matched_at <= GROUPING_WINDOW:
                chain.append(candidate)
                continue
            if len(chain) > 1:
                chains.append(chain)
            chain = [candidate]
        if len(chain) > 1:
            chains.append(chain)

    if not chains:
        return visible
    if not get_group_duplicates(db):
        return visible

    source_ids = {member.source_id for chain in chains for member in chain}
    source_names: dict[int, str] = {
        row.id: row.name
        for row in db.execute(select(Source.id, Source.name).where(Source.id.in_(source_ids)))
    }

    hidden_ids: set[int] = set()
    for chain in chains:
        _attach_duplicate_group(chain, source_names, hidden_ids)

    return [response for response in visible if response.id not in hidden_ids]


def _build_match_response(
    db_match: Match,
    *,
    lowest_price_cents: int | None,
    snoozed_now: bool,
    target_price_cents: int | None,
    correction_admin_id: int | None,
    correction_created_at: datetime | None,
) -> MatchResponse:
    """One `Match` row's aggregates (already fetched by the caller's own
    query — `list_matches` or `_fetch_match_response`) turned into a
    `MatchResponse`. `deliveries`/`sparkline` are filled in by the caller
    afterwards, same as before this was split out. `grouped_match_ids`/
    `group_key`/`telegram_message_id` start as a "group of one" (S14-05) —
    `_apply_duplicate_grouping` is the only thing that ever widens
    `grouped_match_ids` past `[db_match.id]` or sets `seen_count`/`sources`,
    and it only runs in `list_matches`, never in `_fetch_match_response`
    (a single match is never folded into a sibling card by its own request).
    """
    last_correction = (
        MatchCorrectionResponse(admin_id=correction_admin_id, created_at=correction_created_at)
        if correction_admin_id is not None and correction_created_at is not None
        else None
    )
    return MatchResponse(
        id=db_match.id,
        source_id=db_match.source_id,
        rule_id=db_match.rule_id,
        message_text=db_match.message_text,
        price_cents=db_match.price_cents,
        price_cash_cents=db_match.price_cash_cents,
        price_card_cents=db_match.price_card_cents,
        message_link=db_match.message_link,
        matched_at=db_match.matched_at,
        created_at=db_match.created_at,
        deliveries=[],
        is_lowest_price_ever=(
            db_match.price_cents is not None and db_match.price_cents == lowest_price_cents
        ),
        product_key=db_match.product_key,
        snoozed=bool(snoozed_now),
        target_price_cents=target_price_cents,
        target_hit=target_hit(db_match.price_cents, target_price_cents),
        target_gap_pct=target_gap_pct(db_match.price_cents, target_price_cents),
        grouped_match_ids=[db_match.id],
        group_key=compute_group_key(
            db_match.product_key, db_match.price_cents, db_match.matched_at
        ),
        telegram_message_id=db_match.telegram_message_id,
        display_name=db_match.display_name,
        model_variant=db_match.model_variant,
        price_source=db_match.price_source,  # type: ignore[arg-type]
        original_price_cents=db_match.original_price_cents,
        last_correction=last_correction,
    )


@router.get("", response_model=list[MatchResponse])
def list_matches(
    rule_id: int | None = Query(default=None, ge=1),
    source_id: int | None = Query(default=None, ge=1),
    recipient_id: int | None = Query(default=None, ge=1),
    price_cents: int | None = Query(default=None, ge=0),
    min_price_cents: int | None = Query(default=None, ge=0),
    max_price_cents: int | None = Query(default=None, ge=0),
    delivery_status: str | None = Query(default=None, min_length=1, max_length=32),
    sort: Literal["price_asc", "price_desc"] | None = Query(default=None),
    db: Session = Depends(get_db),
    now: datetime = Depends(utc_now),
    tz: ZoneInfo = Depends(get_display_timezone),
) -> list[MatchResponse]:
    if (
        min_price_cents is not None
        and max_price_cents is not None
        and min_price_cents > max_price_cents
    ):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="min_price_cents must not exceed max_price_cents",
        )

    statement = select(
        Match,
        Delivery,
        _lowest_price_cents_per_rule(),
        _snoozed_now(now),
        _target_price_cents_per_rule(),
        _latest_correction_admin_id(),
        _latest_correction_created_at(),
    ).outerjoin(Delivery, Delivery.match_id == Match.id)
    statement = _match_filters(
        statement,
        rule_id=rule_id,
        source_id=source_id,
        recipient_id=recipient_id,
        price_cents=price_cents,
        min_price_cents=min_price_cents,
        max_price_cents=max_price_cents,
        delivery_status=delivery_status,
    ).order_by(*_order_by(sort))

    matches: dict[int, MatchResponse] = {}
    for (
        db_match,
        delivery,
        lowest_price_cents,
        snoozed_now,
        target_price_cents,
        correction_admin_id,
        correction_created_at,
    ) in db.execute(statement):
        response = matches.get(db_match.id)
        if response is None:
            response = _build_match_response(
                db_match,
                lowest_price_cents=lowest_price_cents,
                snoozed_now=snoozed_now,
                target_price_cents=target_price_cents,
                correction_admin_id=correction_admin_id,
                correction_created_at=correction_created_at,
            )
            matches[db_match.id] = response
        if delivery is not None:
            response.deliveries.append(DeliveryResponse.model_validate(delivery))

    visible = _apply_display_grouping(matches)
    visible = _apply_duplicate_grouping(db, visible)
    # S14-02: a target hit is prioritized in the live feed's own ordering,
    # on top of whatever `sort`/grouping already produced — a stable sort
    # only moves target hits to the front, it never reorders within either
    # group.
    visible.sort(key=lambda response: not response.target_hit)
    _attach_sparklines(db, visible, now=now, tz=tz)
    return visible


def _attach_sparklines(
    db: Session, responses: list[MatchResponse], *, now: datetime, tz: ZoneInfo
) -> None:
    keys = {response.product_key for response in responses if response.product_key is not None}
    sparklines = sparklines_for_keys(db, keys, now, tz)
    for response in responses:
        if response.product_key is None:
            continue
        response.sparkline = [
            PricePointResponse.from_point(point)
            for point in sparklines.get(response.product_key, [])
        ]


def _fetch_match_response(
    db: Session, match_id: int, *, now: datetime, tz: ZoneInfo
) -> MatchResponse | None:
    """The single-match equivalent of `list_matches`'s own query + response
    build, reused by `PATCH /matches/{id}` and `POST /matches/{id}/revert`
    so both return the exact same shape (deliveries, sparkline, target/
    snooze flags, last correction) a feed row would — never a hand-trimmed
    subset. No display grouping here on purpose: a single match is never
    folded into a sibling card by its own request.
    """
    statement = (
        select(
            Match,
            Delivery,
            _lowest_price_cents_per_rule(),
            _snoozed_now(now),
            _target_price_cents_per_rule(),
            _latest_correction_admin_id(),
            _latest_correction_created_at(),
        )
        .outerjoin(Delivery, Delivery.match_id == Match.id)
        .where(Match.id == match_id)
    )

    response: MatchResponse | None = None
    for (
        db_match,
        delivery,
        lowest_price_cents,
        snoozed_now,
        target_price_cents,
        correction_admin_id,
        correction_created_at,
    ) in db.execute(statement):
        if response is None:
            response = _build_match_response(
                db_match,
                lowest_price_cents=lowest_price_cents,
                snoozed_now=snoozed_now,
                target_price_cents=target_price_cents,
                correction_admin_id=correction_admin_id,
                correction_created_at=correction_created_at,
            )
        if delivery is not None:
            response.deliveries.append(DeliveryResponse.model_validate(delivery))

    if response is not None:
        _attach_sparklines(db, [response], now=now, tz=tz)
    return response


# --- F7: manual product edit + "Reverter ao detectado" ---------------------

DISPLAY_NAME_MIN_LENGTH = 3
DISPLAY_NAME_MAX_LENGTH = 120
MODEL_VARIANT_MAX_LENGTH = 120

Changes = dict[str, dict[str, Any]]


class MatchUpdate(BaseModel):
    """`PATCH /matches/{id}` (F7). Every field is optional — only the ones
    actually sent are validated and applied, same "if provided" shape as
    `RuleUpdate` (`app.routers.rules`). `price` is free text
    (`packages.rules.manual_price.parse_manual_price_cents` parses it);
    there is no way to clear `display_name`/`model_variant` back to `None`
    through this endpoint on purpose — that is exactly what `POST
    /matches/{id}/revert` ("Reverter ao detectado") does.
    """

    display_name: str | None = None
    model_variant: str | None = None
    price: str | None = None
    # S14-06: rewrites *only* `display_name` on every other match sharing
    # this match's `product_key` (never `model_variant`/`price` — those are
    # specific to one posting, not the product as a whole). Each sibling
    # actually changed gets its own `MatchCorrection` row, same as this
    # match's own edit — chosen over a single "group" row so every match's
    # "última correção" (tela 08) is always about that match itself, never a
    # correction that visibly belongs to a different id.
    apply_name_to_product: bool = False


def _validate_display_name(raw: str) -> str:
    trimmed = raw.strip()
    if not (DISPLAY_NAME_MIN_LENGTH <= len(trimmed) <= DISPLAY_NAME_MAX_LENGTH):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=(
                f"O nome deve ter entre {DISPLAY_NAME_MIN_LENGTH} e "
                f"{DISPLAY_NAME_MAX_LENGTH} caracteres."
            ),
        )
    return trimmed


def _validate_model_variant(raw: str) -> str | None:
    trimmed = raw.strip()
    if not trimmed:
        return None
    if len(trimmed) > MODEL_VARIANT_MAX_LENGTH:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=f"A variante do modelo deve ter até {MODEL_VARIANT_MAX_LENGTH} caracteres.",
        )
    return trimmed


def _parse_price_or_422(raw: str) -> int:
    try:
        return parse_manual_price_cents(raw)
    except PriceParseError as error:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(error)
        ) from error


async def _send_manual_target_alert_if_hit(
    db: Session, match: Match, notifier_factory: BotNotifierFactory
) -> None:
    """S14-06 (F7): the price target alert a manual save can trigger.

    Fires at most once per `(match, recipient)` ever, enforced two ways: the
    DB's own `uq_delivery_match_recipient_kind` constraint (the real
    backstop) and this function's own existence check first (so a repeat
    save is a silent no-op instead of a caught `IntegrityError`). Saving the
    same match twice, or reverting and saving again, both land here again —
    neither ever sends a second `manual_target` delivery to a recipient that
    already has one, exactly like `POST /snoozes`-adjacent flows in this
    codebase that treat "already recorded" as success, not an error.

    A `not_configured` notifier (no bot token) still writes the bookkeeping
    `Delivery` row (`status="not_configured"`) — the same "never fake it, but
    always record the attempt" contract `app.pipeline.process_message` keeps
    for the other two channels.
    """
    rule = db.get(Rule, match.rule_id)
    if rule is None or not target_hit(match.price_cents, rule.target_price_cents):
        return
    assert match.price_cents is not None  # target_hit guarantees this

    recipients = list(
        db.scalars(
            select(Recipient).where(Recipient.active.is_(True), Recipient.allowlisted.is_(True))
        )
    )
    if not recipients:
        return

    pending = [
        recipient
        for recipient in recipients
        if db.scalar(
            select(Delivery.id).where(
                Delivery.match_id == match.id,
                Delivery.recipient_id == recipient.id,
                Delivery.kind == DELIVERY_KIND_MANUAL_TARGET,
            )
        )
        is None
    ]
    if not pending:
        return

    notifier = notifier_factory({recipient.telegram_chat_id for recipient in pending})
    notify_text = build_target_alert_text(match.message_text, rule, match.price_cents)

    for recipient in pending:
        try:
            result = await notifier.notify(
                match_id=match.id,
                recipient_id=recipient.id,
                chat_id=recipient.telegram_chat_id,
                text=notify_text,
            )
        except Exception:  # one recipient's failure must not sink the others
            db.add(
                Delivery(
                    match_id=match.id,
                    recipient_id=recipient.id,
                    kind=DELIVERY_KIND_MANUAL_TARGET,
                    status="failed",
                )
            )
            continue

        db.add(
            Delivery(
                match_id=match.id,
                recipient_id=recipient.id,
                kind=DELIVERY_KIND_MANUAL_TARGET,
                status="sent" if result.delivered else (result.reason or "skipped"),
                delivered_at=datetime.now(UTC) if result.delivered else None,
            )
        )
    db.flush()


@router.patch(
    "/{match_id}",
    response_model=MatchResponse,
    dependencies=[Depends(require_csrf)],
)
async def update_match(
    match_id: int,
    payload: MatchUpdate,
    session_record: SessionRecord = Depends(get_current_session),
    db: Session = Depends(get_db),
    now: datetime = Depends(utc_now),
    tz: ZoneInfo = Depends(get_display_timezone),
    notifier_factory: BotNotifierFactory = Depends(get_bot_notifier_factory),
) -> MatchResponse:
    match = db.get(Match, match_id)
    if match is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="match not found")

    if payload.apply_name_to_product and payload.display_name is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="apply_name_to_product requer display_name.",
        )

    changes: Changes = {}

    if payload.display_name is not None:
        new_display_name = _validate_display_name(payload.display_name)
        if new_display_name != match.display_name:
            changes["display_name"] = {"before": match.display_name, "after": new_display_name}
            match.display_name = new_display_name

    if payload.model_variant is not None:
        new_model_variant = _validate_model_variant(payload.model_variant)
        if new_model_variant != match.model_variant:
            changes["model_variant"] = {
                "before": match.model_variant,
                "after": new_model_variant,
            }
            match.model_variant = new_model_variant

    price_changed = False
    if payload.price is not None:
        new_price_cents = _parse_price_or_422(payload.price)
        if new_price_cents != match.price_cents:
            # S14-06: `original_price_cents` is set exactly once, the first
            # time this match is ever corrected — never overwritten by a
            # later edit, so it always mirrors what `extract_price` found.
            if match.original_price_cents is None:
                match.original_price_cents = match.price_cents
            changes["price_cents"] = {"before": match.price_cents, "after": new_price_cents}
            match.price_cents = new_price_cents
            match.price_source = "manual"
            price_changed = True

    if changes:
        db.add(
            MatchCorrection(match_id=match.id, admin_id=session_record.admin_id, changes=changes)
        )

    if payload.apply_name_to_product and match.product_key is not None:
        assert payload.display_name is not None
        applied_display_name = _validate_display_name(payload.display_name)
        siblings = db.scalars(
            select(Match).where(Match.product_key == match.product_key, Match.id != match.id)
        )
        for sibling in siblings:
            if sibling.display_name == applied_display_name:
                continue
            db.add(
                MatchCorrection(
                    match_id=sibling.id,
                    admin_id=session_record.admin_id,
                    changes={
                        "display_name": {
                            "before": sibling.display_name,
                            "after": applied_display_name,
                        }
                    },
                )
            )
            sibling.display_name = applied_display_name

    db.flush()

    if price_changed:
        await _send_manual_target_alert_if_hit(db, match, notifier_factory)

    db.commit()

    response = _fetch_match_response(db, match.id, now=now, tz=tz)
    assert response is not None
    return response


@router.post(
    "/{match_id}/revert",
    response_model=MatchResponse,
    dependencies=[Depends(require_csrf)],
)
def revert_match(
    match_id: int,
    session_record: SessionRecord = Depends(get_current_session),
    db: Session = Depends(get_db),
    now: datetime = Depends(utc_now),
    tz: ZoneInfo = Depends(get_display_timezone),
) -> MatchResponse:
    """"Reverter ao detectado" (F7): restores `price_cents` from
    `original_price_cents` (left untouched — it keeps meaning "the first
    ever detected price" regardless of how many reverts follow) and clears
    every other manual edit field. Never re-sends anything: a target alert
    is only ever triggered by `PATCH /matches/{id}` actually lowering the
    price (see `_send_manual_target_alert_if_hit`), and an already-sent
    `manual_target` `Delivery` row is untouched here either way — it stays
    the truthful record that Gabriel really was notified once.
    """
    match = db.get(Match, match_id)
    if match is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="match not found")

    changes: Changes = {}
    # `price_source == "manual"` (not "was `original_price_cents` set")
    # is the guard: `original_price_cents` can itself legitimately be `NULL`
    # when the first-ever correction happened on a match with no extracted
    # price at all, which would otherwise be indistinguishable from "never
    # edited" — `price_source` never has that ambiguity.
    if match.price_source == "manual":
        if match.price_cents != match.original_price_cents:
            changes["price_cents"] = {
                "before": match.price_cents,
                "after": match.original_price_cents,
            }
            match.price_cents = match.original_price_cents
        changes["price_source"] = {"before": match.price_source, "after": "parsed"}
        match.price_source = "parsed"
    if match.display_name is not None:
        changes["display_name"] = {"before": match.display_name, "after": None}
        match.display_name = None
    if match.model_variant is not None:
        changes["model_variant"] = {"before": match.model_variant, "after": None}
        match.model_variant = None

    if changes:
        db.add(
            MatchCorrection(match_id=match.id, admin_id=session_record.admin_id, changes=changes)
        )
        db.flush()

    db.commit()

    response = _fetch_match_response(db, match.id, now=now, tz=tz)
    assert response is not None
    return response
