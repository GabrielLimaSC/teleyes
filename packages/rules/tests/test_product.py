"""S14-01 recalibration: `product_key` is now a "model fingerprint" (brand +
model-code tokens + line/variant words) instead of the whole title
normalised. Every title below is invented for the test, shaped after the
structure of real promo posts and the real fragmentation patterns the Tech
Lead measured against production data (specs glued or split across a
decimal point, accented spec words, store part codes, CTA footers, a hype
line ahead of the product line) — never copied from a real message."""

import pytest

from packages.rules.product import product_key, product_text, product_title

PALIT_KEY = "palit-rtx-5070-ti-gamingpro"

PALIT_VARIATIONS = [
    # Canonical post: title, blank line, price block, link, footer.
    (
        "Placa de Vídeo Palit RTX 5070 Ti GamingPro 16GB\n\n"
        "💵 R$ 5.749,00 à vista no pix\n"
        "💳 ou 10x de R$ 639,00 sem juros\n\n"
        "https://loja.example/palit\n\nCupom, preço e estoque por tempo limitado."
    ),
    # Caps, no accents, emojis and a different price.
    "🔥 PLACA DE VIDEO PALIT RTX 5070 TI GAMINGPRO 16GB 🔥\n\nR$ 5.499 no pix\nhttps://x.example/1",
    # Price inline on the title line.
    "Placa de Vídeo Palit RTX 5070 Ti GamingPro 16GB por R$ 5.899,90\nhttps://x.example/2",
    # Banner line before the title, coupon and shipping lines after it.
    (
        "⚡️ OFERTA RELÂMPAGO ⚡️\n"
        "Placa de Vídeo Palit RTX 5070 Ti GamingPro 16GB\n\n"
        "🎟 Cupom: GPU150\n🚚 Frete grátis\n5.749,00 no boleto\nhttps://x.example/3"
    ),
    # Leading hype word on the title line itself, installments first.
    "Baixou! Placa de Vídeo Palit RTX 5070 Ti GamingPro 16GB - 12x R$ 499,00\nhttps://x.example/4",
    # Call-to-action line before the link, no link at all in another shape.
    "Placa de Vídeo Palit RTX 5070 Ti GamingPro 16GB\n\n💰 5.749,00\n👉 Compre aqui:",
    # Discount percent and "a partir de".
    "Placa de Vídeo Palit RTX 5070 Ti GamingPro 16GB a partir de R$ 5.600\n15% OFF",
    # Store noise: glued "RTX5070TI", the GamingPro-S suffix, bus/port specs,
    # a long vendor part code and a "resgate todos os" footer.
    (
        "Placa De Video Geforce Nvidia Palit RTX5070TI 16GB GamingPro-S GDDR7 256Bit 3 DP HD\n\n"
        "💰 R$ 5.799,00\n🎯 100-200002099XYZ\n🔗 Resgate todos os cupons\nhttps://x.example/5"
    ),
    # A hype/call line ahead of the product line, on its own line and with
    # no model code of its own — the fingerprint must skip it, not blend it
    # into the key the way a whole-title join would.
    (
        "Se o nome dele ja e insano imagine o desempenho\n"
        "Placa de Vídeo Palit RTX 5070 Ti GamingPro 16GB\n\n"
        "R$ 5.749,00 no pix\nhttps://x.example/6"
    ),
]


@pytest.mark.parametrize("message_text", PALIT_VARIATIONS)
def test_variations_of_case_accent_emoji_price_glued_series_and_noise_share_one_key(
    message_text: str,
) -> None:
    assert product_key(message_text) == PALIT_KEY


@pytest.mark.parametrize(
    ("first", "second"),
    [
        # Different brand, same chip and capacity.
        (
            "Placa de Vídeo Palit RTX 5070 Ti GamingPro 16GB\n\nR$ 5.749,00",
            "Placa de Vídeo Gigabyte RTX 5070 Ti Windforce 16GB\n\nR$ 5.749,00",
        ),
        # Same brand and line, different model code (no "Ti").
        (
            "Placa de Vídeo Palit RTX 5070 Ti GamingPro 16GB\n\nR$ 5.749,00",
            "Placa de Vídeo Palit RTX 5070 GamingPro 12GB\n\nR$ 3.999,00",
        ),
        # Same brand and chip, different line/variant.
        (
            "Placa de Vídeo Palit RTX 5070 Ti GamingPro 16GB\n\nR$ 5.749,00",
            "Placa de Vídeo Palit RTX 5070 Ti Infinity 16GB\n\nR$ 5.699,00",
        ),
        # Same board family, "-B" suffix vs a Gaming Wifi variant.
        (
            "Placa-mãe MSI PRO B840M-B AM5 DDR5 mATX\n\nR$ 599,00",
            "Placa-mãe MSI B840M Gaming Wifi DDR5 AM5 mATX\n\nR$ 749,00",
        ),
        # Same chipset/board name, Wifi White variant must never merge into
        # the plain one (CLAUDE.md: no fuzzy matching, err toward fragmenting).
        (
            "Placa-mãe ASRock B850M Challenger AM5 DDR5 mATX\n\nR$ 899,00",
            "Placa-mãe ASRock B850M Challenger Wifi White AM5 DDR5 mATX Branco\n\nR$ 949,00",
        ),
        # Same brand and capacity, different model code.
        (
            "SSD Kingston NV3 1TB NVMe\n\nR$ 399,00",
            "SSD Kingston NV2 1TB NVMe\n\nR$ 349,00",
        ),
    ],
)
def test_different_products_never_share_a_key(first: str, second: str) -> None:
    assert product_key(first) != product_key(second)


RYZEN_VARIATIONS = [
    # Accented spec word ("Núcleos").
    "Processador AMD Ryzen 7 9800X3D, 8 Núcleos, AM5\n\nR$ 2.899,00",
    # Frequency written with a decimal point, marketing filler, a store part
    # code and "sem vídeo integrado" boilerplate.
    (
        "Processador Amd Ryzen 7 9800X3D 4.7Ghz 5.2Ghz Max Turbo Cache 8 MB "
        "8 Nucleos 16 Threads Am5 Sem Video Integrado 100-200011084XOF\n\nR$ 2.799,00"
    ),
    # Frequency split across a bare space instead of a decimal point
    # ("5.2 GHz" -> "5", "2", "GHz"), parentheses, "Radeon Graphics".
    (
        "Processador AMD Ryzen 7 9800X3D (AM5/ 8 Cores/ 16 Threads/ 5.2 GHz/ "
        "104Mb Cache/Radeon Graphics/Sem cooler\n\nR$ 2.849,00"
    ),
    # No chip-maker word at all.
    "Processador Ryzen 7 9800X3D\n\nR$ 2.999,00",
]


@pytest.mark.parametrize("message_text", RYZEN_VARIATIONS)
def test_cpu_spec_and_part_code_noise_never_fragments_the_key(message_text: str) -> None:
    assert product_key(message_text) == "7-9800x3d"


def test_a_brand_with_no_other_model_code_falls_back_to_capacity() -> None:
    # A plain RAM kit has no board-style model number: capacity is the only
    # thing that tells two Memtech kits apart, so it is kept instead of
    # stripped as a generic spec — but only when nothing else identifies it.
    same_capacity = [
        "Memória RAM 8GB DDR5 4800MHz Gamer Memtech\n\nR$ 219,00\nhttps://x.example/7",
        "MEMORIA RAM 8GB DDR5 4800MHZ GAMER MEMTECH PARA DESKTOP\n\nR$ 199,90 no pix\nhttps://x.example/8",
    ]
    keys = {product_key(text) for text in same_capacity}
    assert len(keys) == 1

    different_capacity = product_key("Memória RAM 16GB DDR5 4800MHz Gamer Memtech\n\nR$ 399,00")
    assert different_capacity not in keys


@pytest.mark.parametrize(
    ("message_text", "expected"),
    [
        ('Monitor LG 27" 2x HDMI\n\nR$ 999,00', "27-monitor-lg"),
        ("Controle 8BitDo 4x4 Pro\nR$ 299", "controle-8bitdo-4x4-pro"),
        ("Fone Soundcore 1.000mAh\nR$ 199,90", "1-000mah-fone-soundcore"),
        ("Notebook Acer Nitro V15 RTX 4050\n\nR$ 4.999,00", "v15-rtx-4050-notebook-acer-nitro"),
    ],
)
def test_products_with_no_recognised_brand_keep_their_digit_tokens(
    message_text: str, expected: str
) -> None:
    assert product_key(message_text) == expected


@pytest.mark.parametrize(
    "message_text",
    [
        "",
        "   \n\n  ",
        "🔥🔥🔥",
        "R$ 5.749,00 no pix",
        "OFERTA RELÂMPAGO!\n\nCompre aqui",
        "Cupom: GPU150",
    ],
)
def test_no_product_text_means_no_key(message_text: str) -> None:
    assert product_key(message_text) is None
    assert product_title(message_text) is None


def test_link_near_the_start_falls_back_to_the_full_text_like_the_web_card() -> None:
    text = "https://loja.example/p\nMouse Logitech G305\nR$ 199"

    assert product_text(text) == text
    assert product_key(text) == "g305-mouse-logitech"


def test_text_after_the_first_link_is_ignored() -> None:
    text = "Mouse Logitech G305\nhttps://loja.example/p\nTeclado Redragon Kumara"

    assert product_key(text) == "g305-mouse-logitech"


def test_title_keeps_original_case_without_emojis_or_price() -> None:
    text = "🔥 Placa de Vídeo Palit RTX 5070 Ti 16GB 🔥\n\n💵 R$ 5.749,00 no pix\nhttps://x.example"

    assert product_title(text) == "Placa de Vídeo Palit RTX 5070 Ti 16GB"


def test_key_is_deterministic_and_url_safe() -> None:
    text = "Cadeira Gamer DT3 Spider-Man™ Edição Especial\n\nR$ 1.299,00"

    key = product_key(text)

    assert key == product_key(text)
    assert key == "dt3-cadeira-spider-man-edicao-especial"
    assert key is not None and all(char.isalnum() or char in "-_" for char in key)


def test_very_long_titles_are_capped_on_a_word_boundary() -> None:
    text = " ".join(f"palavra{index}" for index in range(60))

    key = product_key(text)

    assert key is not None
    assert len(key) <= 200
    assert key.split("-")[-1].startswith("palavra")
