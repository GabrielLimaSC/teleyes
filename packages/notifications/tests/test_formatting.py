from packages.notifications.formatting import format_price_cents


def test_formats_thousands_and_cents() -> None:
    assert format_price_cents(224900) == "R$ 2.249,00"


def test_formats_below_one_thousand() -> None:
    assert format_price_cents(999) == "R$ 9,99"


def test_formats_zero() -> None:
    assert format_price_cents(0) == "R$ 0,00"


def test_formats_millions_with_two_thousand_separators() -> None:
    assert format_price_cents(123456789) == "R$ 1.234.567,89"
