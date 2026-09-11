import re
from dataclasses import dataclass

_MONEY_RE = re.compile(
    r"(?P<installment>\d{1,2}\s*x\s*(?:de\s+)?)?"
    r"(?P<currency>r\$\s*)?"
    r"(?P<value>(?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d{2})?)",
    re.IGNORECASE,
)


@dataclass
class PriceExtraction:
    """Result of `extract_price`.

    `ambiguous` is set when more than one distinct candidate price survives the
    installment filter — callers can still use `price_cents` (the lowest of
    them, our documented conservative policy) but may want to flag the match.
    """

    price_cents: int | None
    ambiguous: bool = False


def _parse_value_to_cents(value: str) -> int:
    cleaned = value.replace(".", "")
    if "," in cleaned:
        reais, cents = cleaned.split(",")
        return int(reais) * 100 + int(cents.ljust(2, "0")[:2])
    return int(cleaned) * 100


def extract_price(text: str) -> PriceExtraction:
    """Conservatively extract a price in cents from a message.

    A bare number only counts as a price candidate when prefixed with `R$` or
    written with a comma decimal (`3899,90`) — plain digits (`128GB`, a year,
    a quantity) are ignored. Values preceded by an installment count
    (`12x de`) are treated as installment amounts, not the total price,
    *unless* it is the only value in the whole message. When multiple total
    (non-installment) prices are found, the lowest one is returned and the
    result is marked ambiguous.
    """
    candidates: list[tuple[int, bool]] = []
    for match in _MONEY_RE.finditer(text):
        value = match.group("value")
        has_currency = bool(match.group("currency"))
        if not has_currency and "," not in value:
            continue
        is_installment = bool(match.group("installment"))
        candidates.append((_parse_value_to_cents(value), is_installment))

    if not candidates:
        return PriceExtraction(price_cents=None)

    if len(candidates) == 1:
        return PriceExtraction(price_cents=candidates[0][0])

    totals = sorted({cents for cents, is_installment in candidates if not is_installment})
    if totals:
        return PriceExtraction(price_cents=totals[0], ambiguous=len(totals) > 1)

    installments = sorted({cents for cents, _ in candidates})
    if len(installments) == 1:
        return PriceExtraction(price_cents=installments[0])
    return PriceExtraction(price_cents=None, ambiguous=True)
