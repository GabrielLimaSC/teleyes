"""S14-06 (F7): parse a manually-typed price into cents.

`app.routers.matches`'s `PATCH /matches/{id}` is the only caller. Deliberately
strict, same reasoning as `packages.rules.price` (CLAUDE.md: no fuzzy
matching) — a human typing a price into a form can write it a handful of
distinct, unambiguous ways, and anything outside that fixed set is rejected
with a pt-BR message rather than guessed:

* `"5.749,00"` — pt-BR thousands (dot) with a 2-digit decimal (comma).
* `"5.749"` — pt-BR thousands alone, always a whole amount (a real decimal
  is never written as a 3-digit group after a dot).
* `"5749,00"` / `"5749,5"` — a bare comma decimal, no thousands grouping.
* `"5749.5"` / `"5749.50"` — a bare dot decimal, no thousands grouping.
* `"5749"` — a plain whole amount.

Every value is parsed through integer arithmetic on the split string, never
`float`, so a value like `R$ 5.749,00` can never drift by a cent through
binary floating-point rounding.
"""

import re

_PTBR_THOUSANDS_DECIMAL_RE = re.compile(r"^\d{1,3}(?:\.\d{3})+,\d{2}$")
_PTBR_THOUSANDS_RE = re.compile(r"^\d{1,3}(?:\.\d{3})+$")
_COMMA_DECIMAL_RE = re.compile(r"^\d+,\d{1,2}$")
_DOT_DECIMAL_RE = re.compile(r"^\d+\.\d{1,2}$")
_PLAIN_INTEGER_RE = re.compile(r"^\d+$")

_INVALID_FORMAT_MESSAGE = (
    "Preço inválido. Use um formato como 5749, 5749,00, 5.749 ou 5.749,00."
)


class PriceParseError(ValueError):
    """Raised with a pt-BR message ready to surface as a 422 `detail`."""


def _reais_and_cents(reais: str, cents: str) -> int:
    return int(reais) * 100 + int(cents.ljust(2, "0")[:2])


def parse_manual_price_cents(raw: str) -> int:
    """Parse a manually-typed price string into cents, or raise `PriceParseError`.

    Rejects anything ambiguous or non-positive with a pt-BR message —
    never silently coerces a value that could mean two different amounts.
    """
    text = raw.strip()
    if text[:2].lower() == "r$":
        text = text[2:].strip()
    if not text:
        raise PriceParseError("Informe um preço.")

    if _PTBR_THOUSANDS_DECIMAL_RE.match(text):
        reais, cents = text.replace(".", "").split(",")
        price_cents = _reais_and_cents(reais, cents)
    elif _PTBR_THOUSANDS_RE.match(text):
        price_cents = int(text.replace(".", "")) * 100
    elif _COMMA_DECIMAL_RE.match(text):
        reais, cents = text.split(",")
        price_cents = _reais_and_cents(reais, cents)
    elif _DOT_DECIMAL_RE.match(text):
        reais, cents = text.split(".")
        price_cents = _reais_and_cents(reais, cents)
    elif _PLAIN_INTEGER_RE.match(text):
        price_cents = int(text) * 100
    else:
        raise PriceParseError(_INVALID_FORMAT_MESSAGE)

    if price_cents <= 0:
        raise PriceParseError("O preço deve ser maior que zero.")
    return price_cents
