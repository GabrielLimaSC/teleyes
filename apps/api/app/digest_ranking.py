"""S27-01: which offers the daily digest shows, and in what order.

The digest used to sort by lowest absolute price, so it surfaced only cheap
items (motherboards, cables) regardless of whether they were a good deal.
Now it ranks by *relative discount* against a reference the app itself saw:

    discount = (reference - price) / reference

* reference = median of the other priced postings of the same `product_key`
  in the last 90 days (distinct messages, bait prices removed first, at least
  `MIN_SAMPLES` of them -- same median/threshold as the purchase savings
  estimate in `app.savings`); when the product has no such history, the
  rule's `target_price_cents`; otherwise no reference.
* a price below `BAIT_FLOOR_RATIO` (25%) of its reference is suspicious
  (coupon/bait, same ratio as the sparkline outlier filter in
  `app.product_history`) and never leads: it ranks after every item without
  a reference.
* tiers: trusted discount (highest first) -> no reference (lowest price
  first) -> suspected bait (closest to the reference first).
* one item per product (best discount, then lowest price); the other offers
  of the same product are returned as `superseded` so the caller can retire
  them instead of leaving them pending forever.
* variety: after ranking, rules are interleaved round-robin so a single rule
  cannot fill the whole summary; the total limit is still the caller's `top_n`.

Nothing here claims savings the app did not measure: the wording is "abaixo da
mediana vista" / "abaixo do alvo".
"""

from __future__ import annotations

import re
import unicodedata
from collections import defaultdict
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, replace
from datetime import datetime, timedelta
from typing import Literal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.savings import MIN_SAMPLES, median
from app.utc import ensure_utc
from models import Match, Rule

BAIT_FLOOR_RATIO = 0.25
REFERENCE_WINDOW = timedelta(days=90)
MIN_DISCOUNT_TO_SHOW_PCT = 1
TITLE_MAX_LENGTH = 70
_IN_CHUNK = 400

ReferenceKind = Literal["median", "target"]
PostingIdentity = tuple[int, int]
HistoryRow = tuple[PostingIdentity, int]


@dataclass(frozen=True)
class DigestQueueItem:
    match_id: int
    price_cents: int | None
    title: str
    message_link: str | None
    matched_at: datetime
    rule_id: int | None = None
    product_key: str | None = None
    reference_cents: int | None = None
    reference_kind: ReferenceKind | None = None
    discount_pct: float | None = None
    suspected_bait: bool = False
    # A worse offer of a product that already has a better one in this digest.
    superseded: bool = False


# --- titles -------------------------------------------------------------------

_MARKDOWN_RE = re.compile(r"\*\*|__|~~|`")
_KEEP_SYMBOLS = frozenset("™©®")
_INVISIBLE = frozenset("️︎‍​⁠")


def clean_title(raw: str, *, max_length: int = TITLE_MAX_LENGTH) -> str:
    """Plain text: no Telegram markdown, no decorative emoji, single spaces,
    cut at `max_length` with an ellipsis (on a word boundary when possible)."""
    text = _MARKDOWN_RE.sub("", raw)
    text = "".join(
        char
        for char in text
        if char not in _INVISIBLE
        and not (unicodedata.category(char) in {"So", "Sk"} and char not in _KEEP_SYMBOLS)
    )
    text = " ".join(text.split()).strip(" -–—:|•*·")
    if len(text) <= max_length:
        return text
    cut = text[: max_length - 1]
    if " " in cut[max_length // 2 :]:
        cut = cut.rsplit(" ", 1)[0]
    return cut.rstrip(" -–—:|,;.") + "…"


# --- references -----------------------------------------------------------------


def _posting_identity(match_id: int, source_id: int, message_id: int | None) -> PostingIdentity:
    return (source_id, message_id) if message_id is not None else (-1, match_id)


def _robust_median(prices: Sequence[int]) -> int | None:
    """Median after dropping prices under 25% of the raw median; `None` when
    fewer than `MIN_SAMPLES` remain."""
    raw = median(prices)
    if raw is None:
        return None
    kept = [price for price in prices if price >= raw * BAIT_FLOOR_RATIO]
    if len(kept) < MIN_SAMPLES:
        return None
    return median(kept)


def load_product_prices(
    session: Session, product_keys: Iterable[str], *, now: datetime
) -> dict[str, list[HistoryRow]]:
    """`{product_key: [(posting identity, price_cents)]}` for the last 90
    days, one distinct posting per (source, message)."""
    keys = sorted(set(product_keys))
    until = ensure_utc(now)
    since = until - REFERENCE_WINDOW
    result: dict[str, list[HistoryRow]] = defaultdict(list)
    seen: set[tuple[str, PostingIdentity]] = set()
    for start in range(0, len(keys), _IN_CHUNK):
        rows = session.execute(
            select(
                Match.id,
                Match.product_key,
                Match.source_id,
                Match.telegram_message_id,
                Match.price_cents,
                Match.matched_at,
            )
            .where(
                Match.product_key.in_(keys[start : start + _IN_CHUNK]),
                Match.price_cents.is_not(None),
                Match.price_cents > 0,
            )
            .order_by(Match.id)
        )
        for match_id, key, source_id, message_id, price, matched_at in rows:
            if key is None or price is None or not since <= ensure_utc(matched_at) <= until:
                continue
            identity = _posting_identity(match_id, source_id, message_id)
            if (key, identity) in seen:
                continue
            seen.add((key, identity))
            result[key].append((identity, price))
    return result


def with_reference(
    item: DigestQueueItem,
    *,
    history: Sequence[HistoryRow],
    own_identity: PostingIdentity,
    target_cents: int | None,
) -> DigestQueueItem:
    """Attach reference, discount and bait flag; items without a trustworthy
    reference come back unchanged (no discount)."""
    price = item.price_cents
    if price is None or price <= 0:
        return item
    others = [p for identity, p in history if identity != own_identity]
    reference = _robust_median(others)
    kind: ReferenceKind | None = "median" if reference is not None else None
    if reference is None and target_cents is not None and target_cents > 0:
        reference, kind = target_cents, "target"
    if reference is None or kind is None:
        return item
    return replace(
        item,
        reference_cents=reference,
        reference_kind=kind,
        discount_pct=round((reference - price) / reference * 100, 1),
        suspected_bait=price < reference * BAIT_FLOOR_RATIO,
    )


def enrich_items(
    session: Session, items: Sequence[DigestQueueItem], *, now: datetime
) -> list[DigestQueueItem]:
    """Fill references for every item (needs `rule_id`/`product_key`)."""
    if not items:
        return []
    keys = [item.product_key for item in items if item.product_key]
    history = load_product_prices(session, keys, now=now)
    rule_ids = {item.rule_id for item in items if item.rule_id is not None}
    targets: dict[int, int | None] = {
        rule_id: target
        for rule_id, target in session.execute(
            select(Rule.id, Rule.target_price_cents).where(Rule.id.in_(rule_ids))
        )
    }
    identities: dict[int, PostingIdentity] = {
        match_id: _posting_identity(match_id, source_id, message_id)
        for match_id, source_id, message_id in session.execute(
            select(Match.id, Match.source_id, Match.telegram_message_id).where(
                Match.id.in_([item.match_id for item in items])
            )
        )
    }
    return [
        with_reference(
            item,
            history=history.get(item.product_key, []) if item.product_key else [],
            own_identity=identities.get(item.match_id, (-1, item.match_id)),
            target_cents=targets.get(item.rule_id) if item.rule_id is not None else None,
        )
        for item in items
    ]


# --- ranking ----------------------------------------------------------------------


def _rank_key(item: DigestQueueItem) -> tuple[int, float, int, datetime, int]:
    price = item.price_cents if item.price_cents is not None else 0
    if item.discount_pct is not None and not item.suspected_bait:
        return (0, -item.discount_pct, price, item.matched_at, item.match_id)
    if item.discount_pct is None:
        # no reference: cheapest first, unpriced last
        return (1, float(item.price_cents is None), price, item.matched_at, item.match_id)
    # suspected bait: the least extreme (closest to the reference) first
    return (2, item.discount_pct, price, item.matched_at, item.match_id)


def rank_digest_items(items: Sequence[DigestQueueItem]) -> list[DigestQueueItem]:
    """Dedupe by product, rank by discount, interleave rules. Superseded
    offers are appended last (flagged) and never count toward `top_n`."""
    best: dict[str, DigestQueueItem] = {}
    superseded: list[DigestQueueItem] = []
    for item in sorted(items, key=_rank_key):
        key = item.product_key if item.product_key else f"match:{item.match_id}"
        if key in best:
            superseded.append(replace(item, superseded=True))
        else:
            best[key] = item
    unique = sorted(best.values(), key=_rank_key)
    # Interleave rules inside each tier only, so variety never lifts a bait
    # price or an unreferenced item above a trusted discount.
    ordered: list[DigestQueueItem] = []
    for tier in (0, 1, 2):
        ordered += _round_robin_by_rule([i for i in unique if _rank_key(i)[0] == tier])
    return ordered + superseded


def _round_robin_by_rule(ranked: Sequence[DigestQueueItem]) -> list[DigestQueueItem]:
    per_rule: dict[int | None, list[DigestQueueItem]] = defaultdict(list)
    for item in ranked:
        per_rule[item.rule_id].append(item)
    position = {item.match_id: index for index, item in enumerate(ranked)}
    ordered: list[DigestQueueItem] = []
    depth = 0
    while len(ordered) < len(ranked):
        layer = [queue[depth] for queue in per_rule.values() if len(queue) > depth]
        layer.sort(key=lambda item: position[item.match_id])
        ordered.extend(layer)
        depth += 1
    return ordered


def reference_label(item: DigestQueueItem) -> str | None:
    """Honest wording; only for a trusted reference and a visible discount."""
    if (
        item.discount_pct is None
        or item.suspected_bait
        or item.reference_kind is None
        or item.discount_pct < MIN_DISCOUNT_TO_SHOW_PCT
    ):
        return None
    pct = round(item.discount_pct)
    if item.reference_kind == "median":
        return f"{pct}% abaixo da mediana vista"
    return f"{pct}% abaixo do alvo"
