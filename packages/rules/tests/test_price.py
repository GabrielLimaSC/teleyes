from packages.rules.price import extract_price


def test_extracts_price_with_currency_symbol_and_no_cents() -> None:
    result = extract_price("Promoção: R$ 3.899, aproveite!")

    assert result.price_cents == 389900
    assert result.ambiguous is False


def test_extracts_price_with_comma_decimal_and_no_currency_symbol() -> None:
    result = extract_price("Só hoje por 3899,90 no pix")

    assert result.price_cents == 389990


def test_extracts_price_with_thousands_dot_and_comma_decimal() -> None:
    result = extract_price("Fechado em 3.899,00 à vista")

    assert result.price_cents == 389900


def test_installment_alone_is_used_as_price_when_its_the_only_value() -> None:
    result = extract_price("Sai por 12x de R$ 199,90 sem juros")

    assert result.price_cents == 19990
    assert result.ambiguous is False


def test_installment_is_ignored_when_a_total_price_is_also_present() -> None:
    result = extract_price("De R$ 2.399 por R$ 2.399 ou 12x de R$ 199,90 sem juros")

    assert result.price_cents == 239900
    assert result.ambiguous is False


def test_multiple_total_prices_returns_lowest_and_flags_ambiguous() -> None:
    result = extract_price("De R$ 500 por R$ 399, mas hoje só R$ 350")

    assert result.price_cents == 35000
    assert result.ambiguous is True


def test_repeated_identical_total_price_is_not_ambiguous() -> None:
    result = extract_price("R$ 199 por apenas R$ 199, aproveite")

    assert result.price_cents == 19900
    assert result.ambiguous is False


def test_multiple_different_installment_only_values_are_ambiguous_without_price() -> None:
    result = extract_price("10x de R$ 50 ou então 12x de R$ 45")

    assert result.price_cents is None
    assert result.ambiguous is True


def test_message_without_any_price_does_not_raise() -> None:
    result = extract_price("Chegou a nova coleção, corre lá!")

    assert result.price_cents is None
    assert result.ambiguous is False


def test_bare_number_without_currency_or_comma_is_ignored() -> None:
    result = extract_price("iPhone 128GB lançado em 2024")

    assert result.price_cents is None
