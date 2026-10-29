"""S19-04: `GET /savings/report` — the savings estimate of every registered purchase.

Read-only and computed on every request (nothing persisted). All the arithmetic is in
`app.savings`; this module only gathers the prices the app saw and the aggregate
counters. The response never carries Telegram content: no message text, link, group
or store taken from a message, and no `product_key` — only the purchase's own typed
name/store and numbers.
"""

from datetime import date as LocalDate
from datetime import datetime, timedelta
from typing import Annotated, Literal
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import distinct, func, select
from sqlalchemy.orm import Session

from app.main import get_current_session, get_db
from app.product_history import (
    get_display_timezone,
    load_postings,
    load_rule_price_points,
    posting_identity,
)
from app.savings import (
    LONG_WINDOW_DAYS,
    Observation,
    PurchaseSavings,
    black_friday,
    days_before,
    purchase_savings,
    totals,
)
from app.utc import UtcDatetime, ensure_utc, utc_now
from models import Delivery, Match, Purchase
from packages.metrics.counters import MetricCounter, MetricReason

router = APIRouter(
    prefix="/savings",
    tags=["savings"],
    dependencies=[Depends(get_current_session)],
)

GROUPED_STATUS = "grouped"  # app.pipeline.GROUPED_DELIVERY_STATUS
SENT_STATUS = "sent"


class ItemSavingsResponse(BaseModel):
    status: Literal["ok", "no_data"]
    samples_90d: int
    samples_30d: int
    median_30d_cents: int | None
    average_30d_cents: int | None
    median_90d_cents: int | None
    average_90d_cents: int | None
    lowest_seen_cents: int | None
    highest_seen_cents: int | None
    usual_price_cents: int | None
    saving_vs_median_cents: int | None
    saving_vs_median_pct: float | None
    saving_vs_usual_cents: int | None
    saving_vs_usual_pct: float | None


class ReportItemResponse(BaseModel):
    id: int
    name: str
    store: str | None
    price_cents: int
    purchased_at: UtcDatetime
    linked: bool
    days_before_black_friday: int
    # `None` for a purchase with no product/rule link: only the amount paid is shown.
    savings: ItemSavingsResponse | None


class ReportTotalsResponse(BaseModel):
    purchases: int
    linked_with_data: int
    total_paid_cents: int
    estimated_saving_cents: int
    reference_total_cents: int
    estimated_saving_pct: float | None


class BlackFridaySummaryResponse(BaseModel):
    date: LocalDate
    is_default: bool
    purchases_before: int
    days_before_min: int | None
    days_before_max: int | None


class DiscardedResponse(BaseModel):
    sem_termo: int
    bloqueado: int
    preco_acima_teto: int


class NoiseResponse(BaseModel):
    """Aggregates only. `counters_scope` says the metric counters are cumulative since
    the database existed (they have no date), the other numbers cover the period."""

    period_start: UtcDatetime
    period_end: UtcDatetime
    counters_scope: Literal["all_time"]
    messages_analyzed: int
    discarded: DiscardedResponse
    alerts_matched: int
    duplicates_grouped: int
    alerts_sent: int


class SavingsReportResponse(BaseModel):
    generated_at: UtcDatetime
    totals: ReportTotalsResponse
    black_friday: BlackFridaySummaryResponse
    items: list[ReportItemResponse]
    noise: NoiseResponse


def _observations(db: Session, purchase: Purchase) -> list[Observation] | None:
    """Prices the app saw for the linked product (or, failing that, rule); `None` if unlinked."""
    if purchase.product_key is not None:
        return [
            Observation(at=posting.matched_at, price_cents=posting.price_cents)
            for posting in load_postings(db, purchase.product_key)
            if posting.price_cents is not None
        ]
    if purchase.rule_id is not None:
        return [
            Observation(at=at, price_cents=price)
            for at, price in load_rule_price_points(db, purchase.rule_id)
        ]
    return None


def _item_savings(result: PurchaseSavings) -> ItemSavingsResponse:
    return ItemSavingsResponse(
        status=result.status,
        samples_90d=result.samples_90d,
        samples_30d=result.samples_30d,
        median_30d_cents=result.median_30d_cents,
        average_30d_cents=result.average_30d_cents,
        median_90d_cents=result.median_90d_cents,
        average_90d_cents=result.average_90d_cents,
        lowest_seen_cents=result.lowest_seen_cents,
        highest_seen_cents=result.highest_seen_cents,
        usual_price_cents=result.usual_price_cents,
        saving_vs_median_cents=result.saving_vs_median_cents,
        saving_vs_median_pct=result.saving_vs_median_pct,
        saving_vs_usual_cents=result.saving_vs_usual_cents,
        saving_vs_usual_pct=result.saving_vs_usual_pct,
    )


def _noise(db: Session, start: datetime, end: datetime) -> NoiseResponse:
    counters: dict[str, int] = {}
    for reason, count in db.execute(
        select(MetricCounter.reason, func.sum(MetricCounter.count)).group_by(MetricCounter.reason)
    ):
        counters[reason] = int(count or 0)
    discarded = DiscardedResponse(
        sem_termo=counters.get(MetricReason.NO_TERM.value, 0),
        bloqueado=counters.get(MetricReason.BLOCKED.value, 0),
        preco_acima_teto=counters.get(MetricReason.PRICE_ABOVE_CEILING.value, 0),
    )
    analyzed = counters.get(MetricReason.SEEN.value, 0) + (
        discarded.sem_termo + discarded.bloqueado + discarded.preco_acima_teto
    )

    postings = {
        posting_identity(row.id, row.source_id, row.telegram_message_id)
        for row in db.execute(
            select(Match.id, Match.source_id, Match.telegram_message_id).where(
                Match.matched_at >= start, Match.matched_at <= end
            )
        )
    }
    grouped = (
        db.scalar(
            select(func.count(distinct(Delivery.match_id)))
            .join(Match, Match.id == Delivery.match_id)
            .where(
                Delivery.status == GROUPED_STATUS,
                Match.matched_at >= start,
                Match.matched_at <= end,
            )
        )
        or 0
    )
    sent = (
        db.scalar(
            select(func.count())
            .select_from(Delivery)
            .where(
                Delivery.status == SENT_STATUS,
                Delivery.created_at >= start,
                Delivery.created_at <= end,
            )
        )
        or 0
    )
    return NoiseResponse(
        period_start=start,
        period_end=end,
        counters_scope="all_time",
        messages_analyzed=analyzed,
        discarded=discarded,
        alerts_matched=len(postings),
        duplicates_grouped=int(grouped),
        alerts_sent=int(sent),
    )


@router.get("/report", response_model=SavingsReportResponse)
def savings_report(
    black_friday_date: Annotated[LocalDate | None, Query(alias="black_friday")] = None,
    db: Session = Depends(get_db),
    now: UtcDatetime = Depends(utc_now),
    tz: ZoneInfo = Depends(get_display_timezone),
) -> SavingsReportResponse:
    purchases = list(db.scalars(select(Purchase).order_by(Purchase.purchased_at, Purchase.id)))
    newest = max((ensure_utc(p.purchased_at) for p in purchases), default=now)
    is_default = black_friday_date is None
    friday = black_friday_date or black_friday(newest.astimezone(tz).year)

    items: list[ReportItemResponse] = []
    results: list[PurchaseSavings | None] = []
    day_gaps: list[int] = []
    for purchase in purchases:
        purchased_at = ensure_utc(purchase.purchased_at)
        observations = _observations(db, purchase)
        result = (
            None
            if observations is None
            else purchase_savings(purchase.price_cents, purchased_at, observations)
        )
        results.append(result)
        gap = days_before(friday, purchased_at.astimezone(tz).date())
        if gap >= 0:
            day_gaps.append(gap)
        items.append(
            ReportItemResponse(
                id=purchase.id,
                name=purchase.name,
                store=purchase.store,
                price_cents=purchase.price_cents,
                purchased_at=purchased_at,
                linked=observations is not None,
                days_before_black_friday=gap,
                savings=None if result is None else _item_savings(result),
            )
        )

    summary = totals([p.price_cents for p in purchases], results)
    first = ensure_utc(purchases[0].purchased_at) if purchases else now
    period_start = first - timedelta(days=LONG_WINDOW_DAYS)
    return SavingsReportResponse(
        generated_at=now,
        totals=ReportTotalsResponse(
            purchases=summary.purchases,
            linked_with_data=summary.linked_with_data,
            total_paid_cents=summary.total_paid_cents,
            estimated_saving_cents=summary.estimated_saving_cents,
            reference_total_cents=summary.reference_total_cents,
            estimated_saving_pct=summary.estimated_saving_pct,
        ),
        black_friday=BlackFridaySummaryResponse(
            date=friday,
            is_default=is_default,
            purchases_before=len(day_gaps),
            days_before_min=min(day_gaps, default=None),
            days_before_max=max(day_gaps, default=None),
        ),
        items=items,
        noise=_noise(db, period_start, now),
    )
