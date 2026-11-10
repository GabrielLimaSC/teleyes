"""S27-05: the product panel's stats and chart ignore bait prices (same robust floor as the sparkline)."""

from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

from app.product_history import Posting, price_stats, series_for_range

NOW = datetime(2026, 11, 10, 12, 0, tzinfo=UTC)


def _posting(idx: int, price_cents: int, days_ago: int) -> Posting:
    return Posting(
        id=idx,
        source_id=1,
        source_name="Grupo",
        message_text="x",
        price_cents=price_cents,
        matched_at=NOW - timedelta(days=days_ago),
        message_link=None,
    )


def _history() -> list[Posting]:
    real = [17_000_00, 17_500_00, 16_800_00, 17_200_00, 16_900_00, 17_300_00, 17_100_00]
    postings = [_posting(i, price, days_ago=2 + 3 * i) for i, price in enumerate(real)]
    postings.append(_posting(99, 1_499_00, days_ago=12))  # bait price
    return postings


def test_stats_ignore_a_bait_price() -> None:
    stats = price_stats(_history(), NOW)

    assert stats.lowest_90d_cents == 16_800_00
    assert stats.highest_90d_cents == 17_500_00
    assert stats.average_30d_cents is not None and stats.average_30d_cents > 16_000_00


def test_series_ignores_a_bait_price() -> None:
    series = series_for_range(_history(), NOW, "90d", ZoneInfo("UTC"))

    assert min(point.price_cents for point in series) == 16_800_00


def test_few_postings_keep_every_price() -> None:
    postings = _history()[-3:]  # bait + 2 real: too little to trust a median

    assert price_stats(postings, NOW).lowest_90d_cents == 1_499_00
