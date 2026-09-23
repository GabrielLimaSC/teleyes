"""S14-01: product identity. Every title below is invented for the test, shaped
after the structure of real promo posts (product line, blank line, price
block, coupon, link, footer) — never copied from a real message."""

import pytest

from packages.rules.product import product_key, product_text, product_title

PALIT_KEY = "placa-de-video-palit-rtx-5070-ti-gamingpro-16gb"

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
]


@pytest.mark.parametrize("message_text", PALIT_VARIATIONS)
def test_variations_of_case_accent_emoji_price_and_suffix_share_one_key(
    message_text: str,
) -> None:
    assert product_key(message_text) == PALIT_KEY


@pytest.mark.parametrize(
    ("first", "second"),
    [
        (
            "Placa de Vídeo Palit RTX 5070 Ti GamingPro 16GB\n\nR$ 5.749,00",
            "Placa de Vídeo Gigabyte RTX 5070 Ti Windforce 16GB\n\nR$ 5.749,00",
        ),
        (
            "Placa de Vídeo Palit RTX 5070 Ti GamingPro 16GB\n\nR$ 5.749,00",
            "Placa de Vídeo Palit RTX 5070 GamingPro 12GB\n\nR$ 3.999,00",
        ),
        (
            "SSD Kingston NV3 1TB NVMe\n\nR$ 399,00",
            "SSD Kingston NV3 2TB NVMe\n\nR$ 699,00",
        ),
    ],
)
def test_different_products_never_share_a_key(first: str, second: str) -> None:
    assert product_key(first) != product_key(second)


@pytest.mark.parametrize(
    ("message_text", "expected"),
    [
        ("Monitor LG 27 2x HDMI\n\nR$ 999,00", "monitor-lg-27-2x-hdmi"),
        ("Controle 8BitDo 4x4 Pro\nR$ 299", "controle-8bitdo-4x4-pro"),
        ("Fone Soundcore 1.000mAh\nR$ 199,90", "fone-soundcore-1-000mah"),
        ("Notebook Acer Nitro V15 RTX 4050", "notebook-acer-nitro-v15-rtx-4050"),
    ],
)
def test_model_numbers_that_look_like_prices_are_kept(message_text: str, expected: str) -> None:
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
    assert product_key(text) == "mouse-logitech-g305"


def test_text_after_the_first_link_is_ignored() -> None:
    text = "Mouse Logitech G305\nhttps://loja.example/p\nTeclado Redragon Kumara"

    assert product_key(text) == "mouse-logitech-g305"


def test_title_keeps_original_case_without_emojis_or_price() -> None:
    text = "🔥 Placa de Vídeo Palit RTX 5070 Ti 16GB 🔥\n\n💵 R$ 5.749,00 no pix\nhttps://x.example"

    assert product_title(text) == "Placa de Vídeo Palit RTX 5070 Ti 16GB"


def test_key_is_deterministic_and_url_safe() -> None:
    text = "Cadeira Gamer DT3 Spider-Man™ Edição Especial\n\nR$ 1.299,00"

    key = product_key(text)

    assert key == product_key(text)
    assert key == "cadeira-gamer-dt3-spider-man-edicao-especial"
    assert key is not None and all(char.isalnum() or char in "-_" for char in key)


def test_very_long_titles_are_capped_on_a_word_boundary() -> None:
    text = " ".join(f"palavra{index}" for index in range(60))

    key = product_key(text)

    assert key is not None
    assert len(key) <= 200
    assert key.split("-")[-1].startswith("palavra")
