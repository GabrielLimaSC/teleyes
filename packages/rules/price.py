import re
from dataclasses import dataclass

_MONEY_RE = re.compile(
    r"(?P<installment>\d{1,2}\s*x\s*(?:de\s+)?)?"
    r"(?P<currency>r\$\s*)?"
    r"(?P<value>(?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d{2})?)",
    re.IGNORECASE,
)

# S7-05: explicit textual anchors for "à vista/pix" vs "cartão/parcelado/Nx de"
# — CLAUDE.md requires fuzzy matching to wait for real examples, so these are
# the exact keyword sets the task specified, nothing inferred from position.
_CASH_ANCHOR_RE = re.compile(r"\b(?:a\s*vista|à\s*vista|pix)\b", re.IGNORECASE)
_CARD_ANCHOR_RE = re.compile(r"\b(?:cart[aã]o|parcelado)\b", re.IGNORECASE)


@dataclass
class PriceExtraction:
    """Result of `extract_price`.

    `ambiguous` is set when more than one distinct candidate price survives the
    installment filter — callers can still use `price_cents` (the lowest of
    them, our documented conservative policy) but may want to flag the match.

    `price_cash_cents`/`price_card_cents` (S7-05) are only ever set together,
    and only when the message has two explicit, distinct textual anchors (see
    `_CASH_ANCHOR_RE`/`_CARD_ANCHOR_RE`) each near its own price value — never
    guessed from position alone. When set, `price_cents` mirrors
    `price_cash_cents` (the lower, alert-relevant value) and `ambiguous` is
    `False`, since the two values were successfully told apart.
    """

    price_cents: int | None
    ambiguous: bool = False
    price_cash_cents: int | None = None
    price_card_cents: int | None = None


@dataclass
class _Candidate:
    cents: int
    is_installment: bool
    span: tuple[int, int]


def _parse_value_to_cents(value: str) -> int:
    cleaned = value.replace(".", "")
    if "," in cleaned:
        reais, cents = cleaned.split(",")
        return int(reais) * 100 + int(cents.ljust(2, "0")[:2])
    return int(cleaned) * 100


def _midpoint(span: tuple[int, int]) -> int:
    return (span[0] + span[1]) // 2


def _distance_to_candidate(position: int, candidate: _Candidate) -> int:
    start, end = candidate.span
    if position < start:
        return start - position
    if position > end:
        return position - end
    return 0


def _nearest_candidate(position: int, candidates: list[_Candidate]) -> _Candidate | None:
    if not candidates:
        return None
    return min(candidates, key=lambda c: _distance_to_candidate(position, c))


def _detect_cash_and_card(text: str, candidates: list[_Candidate]) -> tuple[int, int] | None:
    """Cash/card split (S7-05), or `None` if the message doesn't unambiguously
    anchor two distinct values.

    Requires exactly one `à vista`/`pix` mention in the whole message,
    assigned to its nearest price candidate, and exactly one way to identify
    a *different* candidate as the card price: either a single `cartão`/
    `parcelado` mention (assigned to its own nearest remaining candidate), or
    — with no such keyword at all — exactly one installment (`Nx de R$...`)
    candidate left. More than one mention of either anchor, or no candidate
    left to assign, means this message is too ambiguous to trust — never
    guessed from bare position. The installment amount, when used, is taken
    as-is, never multiplied by the installment count — that would invent a
    total this codebase has never seen confirmed by a real example, which
    `CLAUDE.md` explicitly asks to avoid.
    """
    cash_anchors = list(_CASH_ANCHOR_RE.finditer(text))
    if len(cash_anchors) != 1:
        return None
    cash_candidate = _nearest_candidate(_midpoint(cash_anchors[0].span()), candidates)
    if cash_candidate is None:
        return None

    remaining = [c for c in candidates if c is not cash_candidate]
    card_anchors = list(_CARD_ANCHOR_RE.finditer(text))
    if len(card_anchors) == 1:
        card_candidate = _nearest_candidate(_midpoint(card_anchors[0].span()), remaining)
    elif not card_anchors:
        installment_candidates = [c for c in remaining if c.is_installment]
        card_candidate = installment_candidates[0] if len(installment_candidates) == 1 else None
    else:
        card_candidate = None  # more than one "cartão"/"parcelado" mention: too unreliable

    if card_candidate is None:
        return None
    if cash_candidate.cents == card_candidate.cents:
        return None
    return cash_candidate.cents, card_candidate.cents


def extract_price(text: str) -> PriceExtraction:
    """Conservatively extract a price in cents from a message.

    A bare number only counts as a price candidate when prefixed with `R$` or
    written with a comma decimal (`3899,90`) — plain digits (`128GB`, a year,
    a quantity) are ignored. Values preceded by an installment count
    (`12x de`) are treated as installment amounts, not the total price,
    *unless* it is the only value in the whole message. When multiple total
    (non-installment) prices are found, the lowest one is returned and the
    result is marked ambiguous — unless they can be told apart as a cash vs.
    card price (S7-05, see `_detect_cash_and_card`).
    """
    candidates: list[_Candidate] = []
    for match in _MONEY_RE.finditer(text):
        value = match.group("value")
        has_currency = bool(match.group("currency"))
        if not has_currency and "," not in value:
            continue
        is_installment = bool(match.group("installment"))
        candidates.append(
            _Candidate(
                cents=_parse_value_to_cents(value),
                is_installment=is_installment,
                span=match.span(),
            )
        )

    if not candidates:
        return PriceExtraction(price_cents=None)

    if len(candidates) > 1:
        dual = _detect_cash_and_card(text, candidates)
        if dual is not None:
            cash_cents, card_cents = dual
            return PriceExtraction(
                price_cents=cash_cents,
                ambiguous=False,
                price_cash_cents=cash_cents,
                price_card_cents=card_cents,
            )

    if len(candidates) == 1:
        return PriceExtraction(price_cents=candidates[0].cents)

    totals = sorted({c.cents for c in candidates if not c.is_installment})
    if totals:
        return PriceExtraction(price_cents=totals[0], ambiguous=len(totals) > 1)

    installments = sorted({c.cents for c in candidates})
    if len(installments) == 1:
        return PriceExtraction(price_cents=installments[0])
    return PriceExtraction(price_cents=None, ambiguous=True)
