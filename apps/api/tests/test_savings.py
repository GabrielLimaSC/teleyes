"""S19-04: the pure savings arithmetic (`app.savings`) — edge cases first."""

from datetime import UTC, date, datetime, timedelta

from app.savings import (
    MIN_SAMPLES,
    Observation,
    black_friday,
    days_before,
    median,
    purchase_savings,
    totals,
    usual_price,
)

BOUGHT = datetime(2026, 10, 20, 12, 0, tzinfo=UTC)


def _obs(days_ago: float, reais: int) -> Observation:
    return Observation(at=BOUGHT - timedelta(days=days_ago), price_cents=reais * 100)


def test_median_handles_empty_odd_and_even() -> None:
    assert median([]) is None
    assert median([300, 100, 200]) == 200
    assert median([100, 201]) == 151


def test_no_history_never_invents_a_saving() -> None:
    result = purchase_savings(150_000, BOUGHT, [])

    assert result.status == "no_data"
    assert result.saving_vs_median_cents is None
    assert result.saving_vs_median_pct is None
    assert result.median_90d_cents is None
    assert result.lowest_seen_cents is None


def test_too_few_samples_is_no_data_but_still_reports_what_was_seen() -> None:
    result = purchase_savings(150_000, BOUGHT, [_obs(5, 1_800), _obs(10, 1_700)])

    assert MIN_SAMPLES == 3
    assert result.status == "no_data"
    assert result.samples_90d == 2
    assert result.saving_vs_median_cents is None
    assert result.lowest_seen_cents == 170_000
    assert result.highest_seen_cents == 180_000


def test_saving_against_the_90_day_median() -> None:
    observations = [_obs(5, 2_000), _obs(20, 2_100), _obs(40, 1_900), _obs(70, 2_200)]

    result = purchase_savings(160_000, BOUGHT, observations)

    assert result.status == "ok"
    assert result.median_90d_cents == 205_000  # even count: between 2.000 and 2.100
    assert result.saving_vs_median_cents == 45_000
    assert result.saving_vs_median_pct == 22.0
    assert result.samples_30d == 2
    assert result.median_30d_cents == 205_000
    assert result.lowest_seen_cents == 190_000
    assert result.highest_seen_cents == 220_000


def test_paying_above_the_median_is_a_negative_saving_not_hidden() -> None:
    observations = [_obs(5, 1_000), _obs(20, 1_000), _obs(30, 1_100)]

    result = purchase_savings(130_000, BOUGHT, observations)

    assert result.status == "ok"
    assert result.saving_vs_median_cents == -30_000
    assert result.saving_vs_median_pct == -30.0


def test_only_prices_up_to_the_purchase_count() -> None:
    observations = [
        _obs(5, 1_000),
        _obs(6, 1_000),
        _obs(7, 1_000),
        _obs(-3, 100),  # a later bargain must not change what was known at purchase time
    ]

    result = purchase_savings(90_000, BOUGHT, observations)

    assert result.median_90d_cents == 100_000
    assert result.lowest_seen_cents == 100_000


def test_prices_older_than_90_days_leave_the_median_but_stay_in_min_max() -> None:
    observations = [_obs(1, 1_000), _obs(2, 1_000), _obs(3, 1_000), _obs(200, 500)]

    result = purchase_savings(100_000, BOUGHT, observations)

    assert result.samples_90d == 3
    assert result.median_90d_cents == 100_000
    assert result.lowest_seen_cents == 50_000
    assert result.saving_vs_median_cents == 0


def test_usual_price_is_the_most_common_band() -> None:
    prices = [199_900, 199_000, 200_500, 250_000, 260_000]

    assert usual_price(prices) == 200_200
    assert usual_price([]) is None


def test_usual_price_tie_prefers_the_band_closest_to_the_median() -> None:
    assert usual_price([100_000, 100_100, 900_000, 900_100, 500_000]) == 100_050


def test_black_friday_is_the_fourth_friday_of_november() -> None:
    assert black_friday(2026) == date(2026, 11, 27)
    assert black_friday(2025) == date(2025, 11, 28)
    assert black_friday(2024) == date(2024, 11, 29)
    assert black_friday(2026).weekday() == 4


def test_days_before_black_friday_is_negative_after_it() -> None:
    friday = date(2026, 11, 27)

    assert days_before(friday, date(2026, 10, 20)) == 38
    assert days_before(friday, date(2026, 11, 27)) == 0
    assert days_before(friday, date(2026, 11, 30)) == -3


def test_totals_only_count_savings_from_purchases_with_data() -> None:
    good = purchase_savings(160_000, BOUGHT, [_obs(5, 2_000), _obs(9, 2_000), _obs(12, 2_000)])
    bad = purchase_savings(130_000, BOUGHT, [_obs(5, 1_000), _obs(9, 1_000), _obs(12, 1_000)])
    thin = purchase_savings(50_000, BOUGHT, [])

    result = totals([160_000, 130_000, 50_000, 90_000], [good, bad, thin, None])

    assert result.purchases == 4
    assert result.linked_with_data == 2
    assert result.total_paid_cents == 430_000
    assert result.estimated_saving_cents == 40_000 - 30_000
    assert result.reference_total_cents == 300_000
    assert result.estimated_saving_pct == 3.3


def test_totals_without_any_usable_data_report_no_percentage() -> None:
    result = totals([10_000], [None])

    assert result.estimated_saving_cents == 0
    assert result.estimated_saving_pct is None
    assert result.linked_with_data == 0
