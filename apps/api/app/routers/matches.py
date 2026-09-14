from datetime import datetime
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, ConfigDict
from sqlalchemy import ScalarSelect, Select, exists, func, select
from sqlalchemy.orm import Session, aliased

from app.main import get_current_session, get_db
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
    message_link: str | None
    matched_at: datetime
    created_at: datetime
    deliveries: list[DeliveryResponse]
    is_lowest_price_ever: bool


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

    return list(matches.values())
