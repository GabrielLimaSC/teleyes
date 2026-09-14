from datetime import datetime
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, ConfigDict
from sqlalchemy import ScalarSelect, Select, exists, func, select
from sqlalchemy.orm import Session, aliased

from app.main import get_current_session, get_db
from app.pipeline import GROUPING_WINDOW
from models import Delivery, Match

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
    delivered_at: datetime | None
    created_at: datetime


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
    matched_at: datetime
    created_at: datetime
    deliveries: list[DeliveryResponse]
    is_lowest_price_ever: bool
    # S7-11 mechanism 2: other sources' ids that posted this same rule+price
    # within GROUPING_WINDOW of this match (chained, so a longer spread-out
    # sequence still collapses into one card) — None when nothing grouped
    # with it. Purely a read-time presentation grouping: every Match row
    # still exists and is unaffected, this only decides which one is the
    # representative card and which ones are folded into it.
    grouped_source_ids: list[int] | None = None


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


def _match_filters(
    statement: Select[tuple[Match, Delivery, int | None]],
    *,
    rule_id: int | None,
    source_id: int | None,
    recipient_id: int | None,
    price_cents: int | None,
    min_price_cents: int | None,
    max_price_cents: int | None,
    delivery_status: str | None,
) -> Select[tuple[Match, Delivery, int | None]]:
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
    rule. `Match.id.desc()` (most recent first) stays the default and the
    tiebreaker for a price tie — same order the UI already showed before
    this existed. `nulls_last()` keeps a match with no extracted price at the
    bottom regardless of direction, since SQLite would otherwise sort NULL
    before every value in `price_asc` (the opposite of what "ascending"
    should mean for a price list a human is scanning).
    """
    if sort == "price_asc":
        return [Match.price_cents.asc().nulls_last(), Match.id.desc(), Delivery.id]
    if sort == "price_desc":
        return [Match.price_cents.desc().nulls_last(), Match.id.desc(), Delivery.id]
    return [Match.id.desc(), Delivery.id]


def _attach_group(chain: list[MatchResponse], hidden_ids: set[int]) -> None:
    """A chain of 2+ chronologically-consecutive same-rule/same-price matches:
    the earliest becomes the representative card (`grouped_source_ids` gets
    every other member's distinct `source_id`) and the rest are hidden from
    the returned list — their `Match`/`Delivery` rows are untouched, only
    excluded from this response.
    """
    if len(chain) < 2:
        return
    representative = chain[0]
    other_source_ids = sorted(
        {member.source_id for member in chain[1:]} - {representative.source_id}
    )
    if other_source_ids:
        representative.grouped_source_ids = other_source_ids
    for member in chain[1:]:
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

    statement = select(Match, Delivery, _lowest_price_cents_per_rule()).outerjoin(
        Delivery, Delivery.match_id == Match.id
    )
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
    for db_match, delivery, lowest_price_cents in db.execute(statement):
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
            )
            matches[db_match.id] = response
        if delivery is not None:
            response.deliveries.append(DeliveryResponse.model_validate(delivery))

    return _apply_display_grouping(matches)
