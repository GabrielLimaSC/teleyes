from datetime import datetime
from typing import Any, Literal
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, ConfigDict
from sqlalchemy import ScalarSelect, Select, and_, exists, func, or_, select
from sqlalchemy.orm import Session, aliased

from app.main import get_current_session, get_db
from app.pipeline import GROUPING_WINDOW
from app.product_history import get_display_timezone, sparklines_for_keys
from app.routers.products import PricePointResponse
from app.utc import UtcDatetime, utc_now
from models import Delivery, Match, Rule, Snooze
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
    for db_match, delivery, lowest_price_cents, snoozed_now, target_price_cents in db.execute(
        statement
    ):
        response = matches.get(db_match.id)
        if response is None:
            response = MatchResponse(
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
            )
            matches[db_match.id] = response
        if delivery is not None:
            response.deliveries.append(DeliveryResponse.model_validate(delivery))

    visible = _apply_display_grouping(matches)
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
