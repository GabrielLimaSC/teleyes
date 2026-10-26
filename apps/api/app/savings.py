"""S19-04: savings estimate of a purchase — pure functions, no database, no clock.

The estimate is *honest by construction*: it only compares what was paid with prices
the app itself saw in Telegram before the purchase. It is never a claim about the
whole market.

* Not enough history (fewer than `MIN_SAMPLES` priced postings in the 90 days before
  the purchase) -> status `"no_data"` and no savings figure at all. Nothing is invented.
* A purchase above the median -> a negative saving, reported as such.

Definitions (all prices in integer cents, `purchased_at` and observations aware UTC):

* observations: priced postings of the linked product/rule with `at <= purchased_at`;
* 30d / 90d window: observations in the 30 / 90 days up to the purchase;
* reference: the 90-day median (the more robust of the two against a single bait price);
* saving = reference - paid (R$ and % of the reference, rounded to 0.1 pp);
* lowest / highest seen: over *all* observations up to the purchase;
* usual price: the most common price band (R$ 10 wide) among the 90-day observations,
  represented by the median of the prices in that band (ties go to the band closest to
  the median, then the lower one).
"""

from collections import Counter
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Literal

MIN_SAMPLES = 3
SHORT_WINDOW_DAYS = 30
LONG_WINDOW_DAYS = 90
USUAL_PRICE_BAND_CENTS = 1_000
THANKSGIVING_THURSDAY_NUMBER = 4  # Black Friday follows the 4th Thursday of November


@dataclass(frozen=True)
class Observation:
    at: datetime
    price_cents: int


@dataclass(frozen=True)
class WindowStats:
    samples: int
    median_cents: int | None
    average_cents: int | None


@dataclass(frozen=True)
class PurchaseSavings:
    status: Literal["ok", "no_data"]
    samples_90d: int
    median_30d_cents: int | None
    average_30d_cents: int | None
    samples_30d: int
    median_90d_cents: int | None
    average_90d_cents: int | None
    lowest_seen_cents: int | None
    highest_seen_cents: int | None
    usual_price_cents: int | None = None
    saving_vs_median_cents: int | None = None
    saving_vs_median_pct: float | None = None
    saving_vs_usual_cents: int | None = None
    saving_vs_usual_pct: float | None = None


def median(values: Sequence[int]) -> int | None:
    """Median in whole cents (half-up on an even count); `None` for no values."""
    if not values:
        return None
    ordered = sorted(values)
    mid = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[mid]
    return (ordered[mid - 1] + ordered[mid] + 1) // 2


def average(values: Sequence[int]) -> int | None:
    if not values:
        return None
    return round(sum(values) / len(values))


def window_stats(prices: Sequence[int]) -> WindowStats:
    return WindowStats(len(prices), median(prices), average(prices))


def usual_price(prices: Sequence[int]) -> int | None:
    """The most common price band, as the median of the prices inside it."""
    if not prices:
        return None
    bands = Counter(round(price / USUAL_PRICE_BAND_CENTS) for price in prices)
    overall = median(prices)
    assert overall is not None
    best_band = min(
        bands,
        key=lambda band: (-bands[band], abs(band * USUAL_PRICE_BAND_CENTS - overall), band),
    )
    in_band = [price for price in prices if round(price / USUAL_PRICE_BAND_CENTS) == best_band]
    return median(in_band)


def _pct(saving_cents: int, reference_cents: int) -> float | None:
    if reference_cents <= 0:
        return None
    return round(saving_cents / reference_cents * 100, 1)


def purchase_savings(
    paid_cents: int, purchased_at: datetime, observations: Sequence[Observation]
) -> PurchaseSavings:
    """Savings of one purchase against the prices seen up to the purchase moment."""
    before = [o for o in observations if o.at <= purchased_at and o.price_cents > 0]
    long_start = purchased_at - timedelta(days=LONG_WINDOW_DAYS)
    short_start = purchased_at - timedelta(days=SHORT_WINDOW_DAYS)
    long_prices = [o.price_cents for o in before if o.at >= long_start]
    short_prices = [o.price_cents for o in before if o.at >= short_start]
    long_stats = window_stats(long_prices)
    short_stats = window_stats(short_prices)
    all_prices = [o.price_cents for o in before]

    lowest = min(all_prices, default=None)
    highest = max(all_prices, default=None)
    if long_stats.samples < MIN_SAMPLES or long_stats.median_cents is None:
        return PurchaseSavings(
            status="no_data",
            samples_90d=long_stats.samples,
            samples_30d=short_stats.samples,
            median_30d_cents=short_stats.median_cents,
            average_30d_cents=short_stats.average_cents,
            median_90d_cents=long_stats.median_cents,
            average_90d_cents=long_stats.average_cents,
            lowest_seen_cents=lowest,
            highest_seen_cents=highest,
        )

    reference = long_stats.median_cents
    usual = usual_price(long_prices)
    saving = reference - paid_cents
    saving_usual = None if usual is None else usual - paid_cents
    return PurchaseSavings(
        status="ok",
        samples_90d=long_stats.samples,
        samples_30d=short_stats.samples,
        median_30d_cents=short_stats.median_cents,
        average_30d_cents=short_stats.average_cents,
        median_90d_cents=reference,
        average_90d_cents=long_stats.average_cents,
        lowest_seen_cents=lowest,
        highest_seen_cents=highest,
        usual_price_cents=usual,
        saving_vs_median_cents=saving,
        saving_vs_median_pct=_pct(saving, reference),
        saving_vs_usual_cents=saving_usual,
        saving_vs_usual_pct=(
            None if usual is None or saving_usual is None else _pct(saving_usual, usual)
        ),
    )


def black_friday(year: int) -> date:
    """Black Friday of `year`: the day after the 4th Thursday of November (2026-11-27).

    That is the 4th Friday of November except in years where November starts on a
    Friday (2024: the 29th, not the 22nd) — it always follows Thanksgiving.
    """
    first = date(year, 11, 1)
    first_thursday = first + timedelta(days=(3 - first.weekday()) % 7)
    return first_thursday + timedelta(weeks=THANKSGIVING_THURSDAY_NUMBER - 1, days=1)


def days_before(target: date, purchased_on: date) -> int:
    """Whole days from the purchase to `target`; negative when the purchase came after it."""
    return (target - purchased_on).days


@dataclass(frozen=True)
class SavingsTotals:
    purchases: int
    linked_with_data: int
    total_paid_cents: int
    estimated_saving_cents: int
    reference_total_cents: int
    estimated_saving_pct: float | None


def totals(paid: Sequence[int], savings: Sequence[PurchaseSavings | None]) -> SavingsTotals:
    """Totals over every purchase; savings only count purchases whose status is `ok`.

    `estimated_saving_cents` can be negative. Purchases without a link or without
    enough history add to the total paid but never to the saving.
    """
    saving = 0
    reference = 0
    counted = 0
    for item in savings:
        if item is None or item.status != "ok" or item.median_90d_cents is None:
            continue
        assert item.saving_vs_median_cents is not None
        saving += item.saving_vs_median_cents
        reference += item.median_90d_cents
        counted += 1
    return SavingsTotals(
        purchases=len(paid),
        linked_with_data=counted,
        total_paid_cents=sum(paid),
        estimated_saving_cents=saving,
        reference_total_cents=reference,
        estimated_saving_pct=_pct(saving, reference) if counted else None,
    )
