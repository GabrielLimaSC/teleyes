"""S14-01: `GET /products/{key}` — one product's price history (F1).

`key` is `Match.product_key` (`packages.rules.product.product_key`). All
numbers are aggregated on read from every match of that key; see
`app.product_history` for the windows and the no-price rule.
"""

from datetime import date as LocalDate
from datetime import datetime
from typing import Annotated
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Path, Query, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.main import get_current_session, get_db
from app.pipeline import evaluate_rule
from app.product_history import (
    HistoryRange,
    Posting,
    PricePoint,
    get_display_timezone,
    load_postings,
    price_stats,
    series_for_range,
)
from app.utc import UtcDatetime, utc_now
from models import Rule
from packages.rules.normalize import normalize_text
from packages.rules.product import is_model_code_token, is_spec_noise_token, product_title

POSTINGS_LIMIT = 100

router = APIRouter(
    prefix="/products",
    tags=["products"],
    dependencies=[Depends(get_current_session)],
)


class PricePointResponse(BaseModel):
    """Lowest price of one local day (`date` is `YYYY-MM-DD` in the display timezone)."""

    date: LocalDate
    price_cents: int

    @classmethod
    def from_point(cls, point: PricePoint) -> "PricePointResponse":
        return cls(date=point.day, price_cents=point.price_cents)


class ProductSourceResponse(BaseModel):
    id: int
    name: str


class ProductPostingResponse(BaseModel):
    id: int
    source_id: int
    source_name: str
    price_cents: int | None
    matched_at: UtcDatetime
    message_link: str | None


class ProductResponse(BaseModel):
    product_key: str
    title: str
    total_count: int
    sources: list[ProductSourceResponse]
    first_seen_at: UtcDatetime
    current_price_cents: int | None
    current_price_at: UtcDatetime | None
    lowest_90d_cents: int | None
    average_30d_cents: int | None
    highest_90d_cents: int | None
    range: HistoryRange
    series: list[PricePointResponse]
    # Newest first, at most POSTINGS_LIMIT; `total_count` is the real total.
    postings: list[ProductPostingResponse]


class RuleSuggestionResponse(BaseModel):
    product_key: str
    name: str
    include_terms: str
    max_price_cents: int | None
    target_price_cents: int | None
    average_30d_cents: int | None
    lowest_90d_cents: int | None


_MAX_CANDIDATE_WIDTH = 6  # a wider window past this never reads as "conservative" any more


def _identity_runs(tokens: list[str]) -> list[tuple[int, int]]:
    """Maximal contiguous `[start, end)` spans of tokens `is_spec_noise_token` rejects."""
    runs: list[tuple[int, int]] = []
    start: int | None = None
    for index, token in enumerate(tokens):
        if is_spec_noise_token(token):
            if start is not None:
                runs.append((start, index))
                start = None
        elif start is None:
            start = index
    if start is not None:
        runs.append((start, len(tokens)))
    return runs


def _candidate_terms_for_title(title: str) -> list[str]:
    """Deterministic, shortest-first contiguous phrases of `title` worth
    trying as a rule's include term — never a single token, never a phrase
    built only from noise words, never a reordering of the real text (unlike
    `product_key`, which deliberately puts brand first and drops duplicates
    — perfect for a stable identity, wrong for a rule term that must appear
    verbatim in the message it is supposed to catch).

    Candidates are built two ways, in order of preference:

    1. Anchored on every "código de modelo" token (`is_model_code_token` — a
       token with a digit that is not itself a capacity/frequency/bus spec,
       "5070"/"9800x3d"/"dt3" rather than "16gb"/"4800mhz"/"ddr5"), widening
       outward from 2 tokens up to `_MAX_CANDIDATE_WIDTH` — the shortest
       window naturally pulls in an immediately adjacent brand/line word
       first, without ever needing to reorder anything.
    2. Only when the title has no such token at all (a brand-only product —
       "Kingston Fury Beast", "Memtech" — S14-01's own `product_key` falls
       back to capacity there for the very same reason): every contiguous
       run of non-noise tokens, widened the same way; a run one token long
       still yields a two-token candidate by bridging to one real neighbour.

    The caller (`get_rule_suggestion`) validates every candidate against the
    product's *real* postings and only ever keeps ones that actually match —
    this function's job is only to propose plausible, literal substrings in
    a sensible order, never to guarantee a match on its own.
    """
    tokens = normalize_text(title).split()
    total = len(tokens)
    if total < 2:
        return []

    ranked: list[tuple[int, int, str]] = []
    seen: set[str] = set()

    def consider(start: int, end: int) -> None:
        if end - start < 2 or start < 0 or end > total:
            return
        span = tokens[start:end]
        if all(is_spec_noise_token(token) for token in span):
            return
        phrase = " ".join(span)
        if phrase in seen:
            return
        seen.add(phrase)
        ranked.append((end - start, start, phrase))

    model_indexes = [index for index, token in enumerate(tokens) if is_model_code_token(token)]
    if model_indexes:
        for anchor in model_indexes:
            max_width = min(total, _MAX_CANDIDATE_WIDTH)
            for width in range(2, max_width + 1):
                for start in range(max(0, anchor - width + 1), min(anchor, total - width) + 1):
                    consider(start, start + width)
    else:
        for run_start, run_end in _identity_runs(tokens):
            if run_end - run_start >= 2:
                max_width = min(run_end - run_start, _MAX_CANDIDATE_WIDTH)
                for width in range(2, max_width + 1):
                    for start in range(run_start, run_end - width + 1):
                        consider(start, start + width)
            else:
                # A lone identity token: bridge to one real neighbour (still
                # a literal, contiguous slice of the title) so it can still
                # produce a two-token candidate.
                consider(run_start - 1, run_start + 1)
                consider(run_start, run_start + 2)

    if not ranked:
        # Every token was noise, or the only runs were unbridgeable — the
        # whole (still real, still literal) title is the last, honest
        # resort, exactly like the old fingerprint fallback used to be.
        return [" ".join(tokens)]

    ranked.sort(key=lambda item: (item[0], item[1]))
    return [phrase for _, _, phrase in ranked]


def _matches_every_word(term: str, message_text: str) -> bool:
    """Would a rule with this one include term (no ceiling) catch `message_text`?

    Reuses `app.pipeline.evaluate_rule` — the exact function the live path,
    the historical scan and `POST /rules/test` all run — against a
    transient, never-persisted `Rule`, so "does this candidate really match"
    means precisely what it would mean once Gabriel saves it for real.
    """
    candidate_rule = Rule(include_terms=term, exclude_terms=None, max_price_cents=None)
    return evaluate_rule(candidate_rule, message_text).discard_reason is None


def _choose_include_terms(candidates: list[str], postings: list[Posting]) -> str:
    """Pick real, verbatim include term(s) that cover every posting of the product.

    The first candidate (shortest first, see `_candidate_terms_for_title`)
    that matches *every* posting's text wins outright — the common case,
    one term. Postings of the same `product_key` can still differ in
    wording (a different store, a different capacity/frequency variant that
    the key intentionally folds together), so when no single candidate
    covers everyone this falls back to a greedy set cover: repeatedly keep
    whichever remaining candidate matches the most still-uncovered
    postings, until either every posting is covered or no remaining
    candidate matches anything left — `include_terms` then carries more
    than one comma-separated term, which `MatchRule` already treats as OR
    alternatives (never AND), so this is exactly what the rule form already
    expects. A posting is only ever left uncovered when *no* candidate
    matches it at all — nothing here invents a term never seen in the text.
    """
    texts = [posting.message_text for posting in postings]
    if not candidates:
        return ""
    if not texts:
        return candidates[0]

    for candidate in candidates:
        if all(_matches_every_word(candidate, text) for text in texts):
            return candidate

    remaining = set(range(len(texts)))
    pool = list(candidates)
    chosen: list[str] = []
    while remaining and pool:
        best_term: str | None = None
        best_cover: set[int] = set()
        for term in pool:
            cover = {index for index in remaining if _matches_every_word(term, texts[index])}
            if len(cover) > len(best_cover):
                best_cover = cover
                best_term = term
        if best_term is None or not best_cover:
            break
        chosen.append(best_term)
        remaining -= best_cover
        pool.remove(best_term)

    return ", ".join(chosen) if chosen else candidates[0]


def _three_percent_below(price_cents: int | None) -> int | None:
    """Subtract 3%, rounding half-up to the nearest cent with integer math."""
    if price_cents is None:
        return None
    return (price_cents * 97 + 50) // 100


@router.get("/{key}/rule-suggestion", response_model=RuleSuggestionResponse)
def get_rule_suggestion(
    key: str = Path(min_length=1, max_length=255),
    db: Session = Depends(get_db),
    now: datetime = Depends(utc_now),
) -> RuleSuggestionResponse:
    postings = load_postings(db, key)
    if not postings:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Product not found")

    # Every distinct title across the product's own postings (newest first,
    # per `load_postings`) — not just the newest one — so a candidate is
    # proposed from each real wording and `_choose_include_terms` can cover
    # postings whose title differs (a different store, a different
    # capacity/frequency variant `product_key` intentionally folds
    # together). `name` stays the newest posting's own title, unchanged.
    titles = list(
        dict.fromkeys(
            cleaned
            for posting in postings
            if (cleaned := product_title(posting.message_text)) is not None
        )
    )
    name = titles[0] if titles else key

    candidates: list[str] = []
    seen_candidates: set[str] = set()
    for candidate_title in titles:
        for phrase in _candidate_terms_for_title(candidate_title):
            if phrase not in seen_candidates:
                seen_candidates.add(phrase)
                candidates.append(phrase)
    candidates.sort(key=lambda phrase: len(phrase.split()))

    if candidates:
        include_terms = _choose_include_terms(candidates, postings)
    else:
        include_terms = normalize_text(key.replace("-", " "))

    stats = price_stats(postings, now)
    return RuleSuggestionResponse(
        product_key=key,
        name=name,
        include_terms=include_terms,
        max_price_cents=_three_percent_below(stats.average_30d_cents),
        target_price_cents=stats.lowest_90d_cents,
        average_30d_cents=stats.average_30d_cents,
        lowest_90d_cents=stats.lowest_90d_cents,
    )


@router.get("/{key}", response_model=ProductResponse)
def get_product(
    key: str = Path(min_length=1, max_length=255),
    history_range: Annotated[HistoryRange, Query(alias="range")] = "90d",
    db: Session = Depends(get_db),
    now: datetime = Depends(utc_now),
    tz: ZoneInfo = Depends(get_display_timezone),
) -> ProductResponse:
    postings = load_postings(db, key)
    if not postings:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Product not found")

    newest = postings[0]
    stats = price_stats(postings, now)
    sources: dict[int, str] = {}
    for posting in sorted(postings, key=lambda posting: posting.matched_at):
        sources.setdefault(posting.source_id, posting.source_name)

    return ProductResponse(
        product_key=key,
        title=product_title(newest.message_text) or key,
        total_count=len(postings),
        sources=[ProductSourceResponse(id=id_, name=name) for id_, name in sources.items()],
        first_seen_at=min(posting.matched_at for posting in postings),
        current_price_cents=stats.current_price_cents,
        current_price_at=stats.current_price_at,
        lowest_90d_cents=stats.lowest_90d_cents,
        average_30d_cents=stats.average_30d_cents,
        highest_90d_cents=stats.highest_90d_cents,
        range=history_range,
        series=[
            PricePointResponse.from_point(point)
            for point in series_for_range(postings, now, history_range, tz)
        ],
        postings=[
            ProductPostingResponse(
                id=posting.id,
                source_id=posting.source_id,
                source_name=posting.source_name,
                price_cents=posting.price_cents,
                matched_at=posting.matched_at,
                message_link=posting.message_link,
            )
            for posting in postings[:POSTINGS_LIMIT]
        ],
    )
