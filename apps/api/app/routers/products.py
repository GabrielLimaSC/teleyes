"""S14-01: `GET /products/{key}` — one product's price history (F1).

`key` is `Match.product_key` (`packages.rules.product.product_key`). All
numbers are aggregated on read from every match of that key; see
`app.product_history` for the windows and the no-price rule.
"""

from datetime import date as LocalDate
from datetime import datetime
from typing import Annotated
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Path, Query, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.main import get_current_session, get_db
from app.product_history import (
    HistoryRange,
    PricePoint,
    get_display_timezone,
    load_postings,
    price_stats,
    series_for_range,
)
from app.utc import UtcDatetime, utc_now
from packages.rules.product import product_title

POSTINGS_LIMIT = 100

router = APIRouter(
    prefix="/products",
    tags=["products"],
    dependencies=[Depends(get_current_session)],
)


class PricePointResponse(BaseModel):
    """Lowest price of one local day (`date` is `YYYY-MM-DD` in the display timezone)."""

    date: LocalDate
    price_cents: int

    @classmethod
    def from_point(cls, point: PricePoint) -> "PricePointResponse":
        return cls(date=point.day, price_cents=point.price_cents)


class ProductSourceResponse(BaseModel):
    id: int
    name: str


class ProductPostingResponse(BaseModel):
    id: int
    source_id: int
    source_name: str
    price_cents: int | None
    matched_at: UtcDatetime
    message_link: str | None


class ProductResponse(BaseModel):
    product_key: str
    title: str
    total_count: int
    sources: list[ProductSourceResponse]
    first_seen_at: UtcDatetime
    current_price_cents: int | None
    current_price_at: UtcDatetime | None
    lowest_90d_cents: int | None
    average_30d_cents: int | None
    highest_90d_cents: int | None
    range: HistoryRange
    series: list[PricePointResponse]
    # Newest first, at most POSTINGS_LIMIT; `total_count` is the real total.
    postings: list[ProductPostingResponse]


@router.get("/{key}", response_model=ProductResponse)
def get_product(
    key: str = Path(min_length=1, max_length=255),
    history_range: Annotated[HistoryRange, Query(alias="range")] = "90d",
    db: Session = Depends(get_db),
    now: datetime = Depends(utc_now),
    tz: ZoneInfo = Depends(get_display_timezone),
) -> ProductResponse:
    postings = load_postings(db, key)
    if not postings:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Product not found")

    newest = postings[0]
    stats = price_stats(postings, now)
    sources: dict[int, str] = {}
    for posting in sorted(postings, key=lambda posting: posting.matched_at):
        sources.setdefault(posting.source_id, posting.source_name)

    return ProductResponse(
        product_key=key,
        title=product_title(newest.message_text) or key,
        total_count=len(postings),
        sources=[ProductSourceResponse(id=id_, name=name) for id_, name in sources.items()],
        first_seen_at=min(posting.matched_at for posting in postings),
        current_price_cents=stats.current_price_cents,
        current_price_at=stats.current_price_at,
        lowest_90d_cents=stats.lowest_90d_cents,
        average_30d_cents=stats.average_30d_cents,
        highest_90d_cents=stats.highest_90d_cents,
        range=history_range,
        series=[
            PricePointResponse.from_point(point)
            for point in series_for_range(postings, now, history_range, tz)
        ],
        postings=[
            ProductPostingResponse(
                id=posting.id,
                source_id=posting.source_id,
                source_name=posting.source_name,
                price_cents=posting.price_cents,
                matched_at=posting.matched_at,
                message_link=posting.message_link,
            )
            for posting in postings[:POSTINGS_LIMIT]
        ],
    )
