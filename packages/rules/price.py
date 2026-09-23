import re
from dataclasses import dataclass

_MONEY_RE = re.compile(
    r"(?P<installment>\d{1,2}\s*x\s*(?:de\s+)?)?"
    r"(?P<currency>r\$\s*)?"
    r"(?P<value>"
    # dot-thousands, optional comma-decimal: "3.899,90" / "3.899". The decimal
    # tail can never be followed by another digit — a real decimal always has
    # exactly 2 digits after the comma (S14-11, see the comma-thousands
    # alternative below for why that lookahead matters).
    r"\d{1,3}(?:\.\d{3})+(?:,\d{2}(?!\d))?"
    # S14-11: US-style thousands separator with a comma, e.g. "6,991" for
    # R$ 6.991 — real feed messages write prices this way, without "R$" and
    # without the usual dot-thousands. A comma followed by exactly 3 digits
    # (repeated), with nothing else around it, can only be a thousands
    # separator: Portuguese decimals always have exactly 2 digits after the
    # comma, never 3. The old regex had no lookahead after `,\d{2}`, so it
    # matched only "6,99" out of "6,991" and silently dropped the trailing
    # "1" — a RTX 5070 at R$ 6.991 was stored as R$ 6,99 and flagged "menor
    # preço já visto". Confirmed against 3 real matches with this exact
    # shape: "6,991", "7,070", "1,007". The trailing lookaheads reject a
    # digit or a further ",dd" right after, so this never eats into a
    # decimal or another number.
    r"|\d{1,3}(?:,\d{3})+(?!\d)(?!,\d)"
    # plain comma-decimal, no thousands grouping: "3899,90" / "6,99". Same
    # not-followed-by-another-digit guard, so "6,991" can never be
    # mis-parsed as "6,99" through this branch either.
    r"|\d+,\d{2}(?!\d)"
    r"|\d+"
    r")",
    re.IGNORECASE,
)

# S14-11: a value matching this exactly (only digits and comma-thousands
# groups, no dot, no decimal tail) came from the comma-thousands branch of
# `_MONEY_RE` above and must be read as whole reais, not as reais-and-cents.
_COMMA_THOUSANDS_RE = re.compile(r"^\d{1,3}(?:,\d{3})+$")

# S7-05: explicit textual anchors for "à vista/pix" vs "cartão/parcelado/Nx de"
# — CLAUDE.md requires fuzzy matching to wait for real examples, so these are
# the exact keyword sets the task specified, nothing inferred from position.
_CASH_ANCHOR_RE = re.compile(r"\b(?:a\s*vista|à\s*vista|pix)\b", re.IGNORECASE)
_CARD_ANCHOR_RE = re.compile(r"\b(?:cart[aã]o|parcelado)\b", re.IGNORECASE)

# S8-01: coupon/discount keywords from the real CMdias message ("cupom de R$
# 90 OFF") plus the task's own confirmed wording variations ("R$X de
# desconto", "cupom: R$X") — anchored on confirmed keywords, not an inferred
# pattern (CLAUDE.md). Split by which side of the anchor the value falls on
# in every confirmed example: "cupom" always precedes its value ("cupom de
# R$X", "cupom: R$X"); "off"/"desconto" always follow theirs ("R$X off",
# "R$X de desconto") — directional, so an unrelated real price sitting a few
# characters away on the *other* side (e.g. "R$ 500, cupom de R$ 50 off")
# can never be picked by raw nearest-distance instead of the actual coupon
# value.
_COUPON_PRECEDING_RE = re.compile(r"\bcupom\b", re.IGNORECASE)
_COUPON_FOLLOWING_RE = re.compile(r"\b(?:off|desconto)\b", re.IGNORECASE)

# S10-01: the text strictly between an anchor and the candidate it would
# exclude must be nothing but a short connector — whitespace, punctuation, or
# the linking word "de" — every confirmed real phrasing ("cupom de R$X",
# "cupom: R$X", "R$X off", "R$X de desconto") has one. Real production
# messages that regressed under S8-01 (see packages/rules/tests/test_price.py
# and the S10-01 task) have unrelated content in that gap instead: a percent
# sign describing a discount *on* the price itself ("R$6.991,08 8% desconto"),
# a plain number that never became its own candidate ("100 OFF", "100" has no
# R$/comma), or a whole unrelated sentence/paragraph — none of those are a
# real coupon value next to the anchor, so the candidate must survive.
_COUPON_GAP_RE = re.compile(r"^[\s,:-]*(?:de\s+)?[\s,:-]*$", re.IGNORECASE)


def _is_connector_gap(text: str, start: int, end: int) -> bool:
    return _COUPON_GAP_RE.match(text[start:end]) is not None


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
    if _COMMA_THOUSANDS_RE.match(value):
        return int(value.replace(",", "")) * 100
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


def _nearest_candidate_after(position: int, candidates: list[_Candidate]) -> _Candidate | None:
    return _nearest_candidate(position, [c for c in candidates if c.span[0] >= position])


def _nearest_candidate_before(position: int, candidates: list[_Candidate]) -> _Candidate | None:
    return _nearest_candidate(position, [c for c in candidates if c.span[1] <= position])


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


def _drop_coupon_candidates(text: str, candidates: list[_Candidate]) -> list[_Candidate]:
    """S8-01: a price value anchored to a coupon/discount keyword ("cupom de
    R$ 90 OFF" in the real CMdias message that exposed this) is never the
    product price — not as the main candidate, not as a last-resort fallback
    either (unlike an installment amount, which legitimately can be the price
    when it's the only candidate in the message).

    Each anchor occurrence excludes only the nearest candidate on its
    confirmed side (`_COUPON_PRECEDING_RE`/`_COUPON_FOLLOWING_RE`) — an
    unrelated real price sitting closer in raw character distance, but on
    the wrong side of the anchor, is never picked (that's why this can't
    reuse the plain `_nearest_candidate` `_detect_cash_and_card` uses: "cupom
    de" there is often only a few characters past an unrelated, real price
    stated just before it).

    S10-01: the nearest candidate on the confirmed side is only actually
    excluded when the gap between it and the anchor is a real connector (see
    `_is_connector_gap`) — otherwise it's not the anchor's own coupon value,
    just whatever real candidate happened to be nearest in a message where
    "cupom"/"off"/"desconto" shows up somewhere unrelated to it (a percentage
    discount on the price itself, a plain number that isn't a real
    candidate, or an unrelated sentence entirely).
    """
    excluded: list[_Candidate] = []

    def _exclude(candidate: _Candidate | None) -> None:
        if candidate is not None and all(candidate is not already for already in excluded):
            excluded.append(candidate)

    for anchor in _COUPON_PRECEDING_RE.finditer(text):
        candidate = _nearest_candidate_after(anchor.end(), candidates)
        if candidate is not None and _is_connector_gap(text, anchor.end(), candidate.span[0]):
            _exclude(candidate)
    for anchor in _COUPON_FOLLOWING_RE.finditer(text):
        candidate = _nearest_candidate_before(anchor.start(), candidates)
        if candidate is not None and _is_connector_gap(text, candidate.span[1], anchor.start()):
            _exclude(candidate)

    if not excluded:
        return candidates
    return [c for c in candidates if all(c is not dropped for dropped in excluded)]


def extract_price(text: str) -> PriceExtraction:
    """Conservatively extract a price in cents from a message.

    A bare number only counts as a price candidate when prefixed with `R$` or
    written with a comma decimal (`3899,90`) — plain digits (`128GB`, a year,
    a quantity) are ignored. Values preceded by an installment count
    (`12x de`) are treated as installment amounts, not the total price,
    *unless* it is the only value in the whole message. A value anchored to a
    coupon/discount keyword (S8-01, see `_drop_coupon_candidates`) is dropped
    before anything else and never becomes the price, even as the sole
    remaining candidate. When multiple total (non-installment) prices are
    found, the lowest one is returned and the result is marked ambiguous —
    unless they can be told apart as a cash vs. card price (S7-05, see
    `_detect_cash_and_card`).
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

    candidates = _drop_coupon_candidates(text, candidates)
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
