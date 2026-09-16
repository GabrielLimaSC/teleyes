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


def test_real_cmdias_message_extracts_the_product_price_not_the_coupon() -> None:
    """S8-01: the exact real message from the homologation bug — the panel
    showed R$ 90,00 (the coupon) instead of R$ 4.516 (the real product
    price), and even flagged it "menor preço já visto".
    """
    result = extract_price(
        "🔥 RTX 5070 ... 💵 R$ 4.516 🎫 Resgatem o cupom de R$ 90 OFF: "
        "https://s.shopee.com.br/abc ⚠️Cupom, preço e estoque por tempo limitado."
    )

    assert result.price_cents == 451600
    assert result.ambiguous is False


def test_single_price_message_with_no_coupon_word_is_unchanged() -> None:
    result = extract_price("RTX 5070 por R$ 4.516")

    assert result.price_cents == 451600
    assert result.ambiguous is False


def test_genuine_ambiguity_without_any_coupon_word_keeps_todays_behavior() -> None:
    """No 'cupom'/'off'/'desconto' anywhere — S8-01 must never touch the
    pre-existing "two real prices, pick the lowest, flag ambiguous" policy.
    """
    result = extract_price("RTX 5070 por R$ 4.000 ou R$ 4.200")

    assert result.price_cents == 400000
    assert result.ambiguous is True


def test_coupon_de_off_phrasing_drops_the_coupon_even_with_a_closer_real_price() -> None:
    """The real price (R$ 500) sits in raw character distance closer to
    "cupom" than the coupon's own value (R$ 50) does — a naive
    nearest-candidate-by-distance would wrongly grab the real price instead.
    Directional association (cupom precedes its value, off follows it) must
    still find the coupon's own R$ 50, not R$ 500.
    """
    result = extract_price("Produto por R$ 500, cupom de R$ 50 off")

    assert result.price_cents == 50000


def test_de_desconto_phrasing_drops_the_coupon() -> None:
    result = extract_price("Produto por R$ 500, R$ 50 de desconto")

    assert result.price_cents == 50000


def test_cupom_colon_phrasing_drops_the_coupon() -> None:
    result = extract_price("Produto por R$ 500, cupom: R$ 50")

    assert result.price_cents == 50000


def test_coupon_value_is_never_the_price_even_as_the_sole_candidate() -> None:
    """Unlike an installment amount (which legitimately becomes the price
    when it's the only value in the message), a coupon-anchored value never
    does — even alone in the message.
    """
    result = extract_price("Use o cupom de R$ 50 off na loja toda")

    assert result.price_cents is None
    assert result.ambiguous is False


def test_coupon_noise_never_leaks_into_a_real_cash_and_card_split() -> None:
    """S8-01 filtering runs before S7-05's cash/card detection — a coupon
    value must never survive as a fake third price nor break a legitimate
    split.
    """
    result = extract_price("R$ 100 a vista ou R$ 120 no cartão, cupom de R$ 10 off")

    assert result.price_cash_cents == 10000
    assert result.price_card_cents == 12000
    assert result.price_cents == 10000


def test_real_pc_do_fafa_message_keeps_the_price_despite_a_percent_discount_mention() -> None:
    """S10-01: production match id 91 — a regression from S8-01. "desconto"
    sits right after the price itself ("R$6.991,08 8% desconto no Pix"),
    describing a percentage discount *on* that price, not a coupon value —
    only 4 characters away from the price, closer than the confirmed "cupom
    de R$ 50 off" phrasing, so a raw distance threshold could never tell
    these apart. The gap has a digit and a '%' in it, not a bare connector,
    which is what actually tells them apart.
    """
    result = extract_price(
        "👌 Placa de Video Geforce Nvidia Palit Rtx 5070 Ti 16Gb Gamingpro-S Gdr7 256Bit "
        "3-Dp Hd\n\n💲 Valor: R$6.991,08 8% desconto no Pix\n\n👉 Resgate o cupom\n"
        "👀 https://pcdofafa.com.br/p/shopee/jb6gwx\n\n👀 https://pcdofafa.com.br/p/shopee/4bfbpd\n\n"
        "✅BOT DE DESCONTOS: @FafaPromobot\n\n_________________________\n"
        "__✅ Oferta verificada: conferimos manualmente o preço e cupom__"
    )

    assert result.price_cents == 699108
    assert result.ambiguous is False


def test_real_pc_do_fafa_message_id93_keeps_the_price_with_an_unrelated_coupon_code() -> None:
    """S10-01: production match id 93 — "Cupom:" is immediately followed by
    a coupon *code* (not a price value), and the two "desconto" mentions are
    each a full sentence away from the price ("Link App com desconto em
    moedas", pure navigation text). Neither anchor has a real coupon value
    next to it, so the price must survive.
    """
    result = extract_price(
        "👌Air Cooler METALFISH ZH-1400, 4 Heatpipes, 1700 1200 1150 1155 1156 1366 2011 "
        "AM5 AM4 AM3 x99 x79\n\n💲Valor: R$85,70\n\n-Cupom: `PGXMHWY67VTZ` +671  Moedas no APP\n\n"
        "✅ Link App com desconto em moedas:\n👀 https://a.aliexpress.com/_c4Wr0VO5\n\n"
        "✅ Link para PC / sem super desconto moedas:\n👀 https://pcdofafa.com.br/p/aliexpress/3uad1x\n\n"
        "✅BOT DE DESCONTOS: @FafaPromobot\n\n-Somente no APP, vai abrir na página de moedas e "
        "clique no primeiro anúncio\n\n_________________________\n"
        "__✅ Oferta verificada: conferimos manualmente o preço e cupon__"
    )

    assert result.price_cents == 8570
    assert result.ambiguous is False


def test_real_cmdias_message_keeps_price_when_coupon_amount_has_no_currency_marker() -> None:
    """S10-01: production matches id 88/89 — "100 OFF" has no `R$`/comma, so
    "100" never becomes a candidate at all (by design, see `extract_price`'s
    own docstring on bare numbers). The old code let "OFF" reach straight
    past it to the real price 25 characters earlier instead of leaving the
    candidate alone when nothing valid sits next to the anchor.
    """
    result = extract_price(
        "🔥 Placa de Vídeo NVIDIA GeForce MSI RTX5060 8GB GDDR7 128BITS SHADOW 2X\n\n"
        "💵 R$ 2.542\n\n🎟 Resgate cupom de 100 OFF:\nhttps://s.shopee.com.br/2gB9kYURhz\n\n"
        "🔗 LINK: https://s.shopee.com.br/2BEt9df9Gx?lp=aff\n\n"
        "⚠️Cupom, preço e estoque por tempo limitado. \n\n"
        "TEM ALGUMA DÚVIDA? ACESSE ESSE LINK ABAIXO E FAÇA SUA PERGUNTA, \n"
        "marque a caixinha \"Me avise quando um ADM me responder\"\nhttps://bit.ly/3UWoxeu\n\n"
        "📢 Anúncio"
    )

    assert result.price_cents == 254200
    assert result.ambiguous is False
