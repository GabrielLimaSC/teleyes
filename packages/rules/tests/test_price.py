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


def test_cash_and_card_prices_split_with_pix_and_cartao_anchors() -> None:
    """S7-05: two distinct total values, each with its own explicit anchor —
    the canonical case from the task's own example.
    """
    result = extract_price("R$ 3.899 no pix ou R$ 4.199 no cartão")

    assert result.price_cash_cents == 389900
    assert result.price_card_cents == 419900
    # price_cents mirrors the cash value — lower, and what an alert cares about.
    assert result.price_cents == 389900
    assert result.ambiguous is False


def test_cash_and_card_prices_split_with_a_vista_and_installment_anchor() -> None:
    """`Nx de` itself counts as a card anchor (per the task spec) — the
    installment's own value is used as-is, never multiplied by the
    installment count (that would invent a total with no real example to
    confirm it, which CLAUDE.md asks to avoid).
    """
    result = extract_price("R$ 3.899 à vista ou 12x de R$ 433,20 no cartão")

    assert result.price_cash_cents == 389900
    assert result.price_card_cents == 43320
    assert result.price_cents == 389900
    assert result.ambiguous is False


def test_single_price_message_never_sets_cash_or_card_fields() -> None:
    result = extract_price("Promoção: R$ 3.899, aproveite!")

    assert result.price_cash_cents is None
    assert result.price_card_cents is None


def test_ambiguous_message_without_explicit_anchors_keeps_todays_behavior() -> None:
    """No 'à vista'/'pix'/'cartão'/'parcelado' anchor anywhere — must never
    guess a cash/card split from position alone, same lowest-of-many policy
    as before S7-05.
    """
    result = extract_price("De R$ 500 por R$ 399, mas hoje só R$ 350")

    assert result.price_cents == 35000
    assert result.ambiguous is True
    assert result.price_cash_cents is None
    assert result.price_card_cents is None


def test_a_lone_cash_anchor_with_no_distinguishable_card_value_does_not_split() -> None:
    result = extract_price("R$ 199,90 à vista, aproveite")

    assert result.price_cents == 19990
    assert result.price_cash_cents is None
    assert result.price_card_cents is None


def test_identical_value_anchored_as_both_cash_and_card_does_not_split() -> None:
    """Same number, both anchors nearby — nothing real to tell apart, so this
    stays the ordinary single-price (non-ambiguous, repeated value) case.
    """
    result = extract_price("R$ 199 à vista ou R$ 199 no cartão")

    assert result.price_cents == 19900
    assert result.ambiguous is False
    assert result.price_cash_cents is None
    assert result.price_card_cents is None
