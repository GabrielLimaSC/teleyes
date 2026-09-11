import pytest

from packages.rules.normalize import normalize_text


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("PROMOÇÃO!!!", "promocao"),
        ("  Café   com Leite  ", "cafe com leite"),
        ("iPhone-15 Pro Max", "iphone 15 pro max"),
        ("R$ 3.899,90", "r 3 899 90"),
        ("já era!", "ja era"),
    ],
)
def test_normalize_text_handles_case_accent_punctuation_and_spacing(
    raw: str, expected: str
) -> None:
    assert normalize_text(raw) == expected
