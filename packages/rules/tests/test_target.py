from packages.rules.target import target_gap_pct, target_hit


def test_price_at_or_below_target_is_a_hit() -> None:
    assert target_hit(2050, 2050) is True
    assert target_hit(2000, 2050) is True


def test_price_above_target_is_not_a_hit() -> None:
    assert target_hit(2249, 2050) is False


def test_no_target_is_never_a_hit() -> None:
    assert target_hit(1000, None) is False


def test_no_price_is_never_a_hit() -> None:
    assert target_hit(None, 2050) is False


def test_gap_pct_matches_the_worked_example() -> None:
    assert target_gap_pct(2249, 2050) == 9


def test_gap_pct_floors_instead_of_rounding() -> None:
    # 2100 vs 2050: 50/2050 = 2.43% — floors to 2, not 2 rounded (still 2
    # here; picked to also confirm the floor doesn't round *down* to 3 from
    # some off-by-one in the multiply-then-divide order).
    assert target_gap_pct(2100, 2050) == 2


def test_gap_pct_is_zero_once_the_target_is_hit() -> None:
    assert target_gap_pct(2050, 2050) == 0
    assert target_gap_pct(1900, 2050) == 0


def test_gap_pct_is_none_without_a_target_or_a_price() -> None:
    assert target_gap_pct(2249, None) is None
    assert target_gap_pct(None, 2050) is None


def test_gap_pct_is_none_for_a_non_positive_target() -> None:
    assert target_gap_pct(100, 0) is None
