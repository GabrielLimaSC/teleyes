import pytest

from packages.rules.manual_price import PriceParseError, parse_manual_price_cents


@pytest.mark.parametrize(
    "raw, expected_cents",
    [
        ("5.749,00", 574_900),  # pt-BR thousands + comma decimal
        ("5.749", 574_900),  # pt-BR thousands alone, always whole
        ("5749", 574_900),  # plain integer
        ("5749.5", 574_950),  # bare dot decimal, 1 digit
        ("5749.50", 574_950),  # bare dot decimal, 2 digits
        ("5749,00", 574_900),  # bare comma decimal, 2 digits
        ("5749,5", 574_950),  # bare comma decimal, 1 digit
        ("  5749  ", 574_900),  # surrounding whitespace trimmed
        ("R$ 5.749,00", 574_900),  # currency prefix stripped
        ("r$5749", 574_900),  # lowercase, no space
        ("1", 100),
        ("100.000", 10_000_000),  # thousands, no decimal
    ],
)
def test_accepts_the_documented_formats(raw: str, expected_cents: int) -> None:
    assert parse_manual_price_cents(raw) == expected_cents


@pytest.mark.parametrize(
    "raw",
    [
        "",
        "   ",
        "abc",
        "5.7.49",  # malformed grouping
        "5,749.00",  # mixed order (US style)
        "5.749,999",  # 3 decimal digits
        "57.4900",  # dot-group not exactly 3 digits
        "5..749",
        "-100",
        "0",
        "-5749,00",
    ],
)
def test_rejects_ambiguous_or_invalid_formats(raw: str) -> None:
    with pytest.raises(PriceParseError):
        parse_manual_price_cents(raw)


def test_rejects_zero_and_negative_amounts_with_a_dedicated_message() -> None:
    with pytest.raises(PriceParseError, match="maior que zero"):
        parse_manual_price_cents("0")


def test_error_message_is_in_pt_br() -> None:
    with pytest.raises(PriceParseError, match="Preço inválido"):
        parse_manual_price_cents("abc")
