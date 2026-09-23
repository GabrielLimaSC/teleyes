"""S14-01: price history per `product_key`, computed on every read.

Same lesson as S7-06 (`is_lowest_price_ever`): nothing here is persisted at
insert time. A historical scan inserts old messages out of order, so a value
frozen on insert could be wrong forever; aggregating on read is always
correct. Everything stored is UTC; only the *day boundary* of the daily
series follows the configured display timezone.

A match without an extracted price counts as a posting of the product but
never enters the series or the statistics — there is no price to plot.
"""

import math
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Literal
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.utc import ensure_utc
from models import Match, Source

HistoryRange = Literal["90d", "30d", "7d"]
RANGE_DAYS: dict[HistoryRange, int] = {"90d": 90, "30d": 30, "7d": 7}

STATS_LONG_WINDOW = timedelta(days=90)
STATS_SHORT_WINDOW = timedelta(days=30)
SPARKLINE_WINDOW = timedelta(days=90)
SPARKLINE_MAX_POINTS = 30
# Above this many distinct keys an `IN (...)` list stops being worth it (and
# SQLite caps bound parameters): read the whole 90-day window instead, still
# one query.
_SPARKLINE_IN_LIMIT = 500


@dataclass(frozen=True)
class PricePoint:
    day: date
    price_cents: int


@dataclass(frozen=True)
class Posting:
    id: int
    source_id: int
    source_name: str
    message_text: str
    price_cents: int | None
    matched_at: datetime
    message_link: str | None


@dataclass(frozen=True)
class PriceStats:
    current_price_cents: int | None
    current_price_at: datetime | None
    lowest_90d_cents: int | None
    average_30d_cents: int | None
    highest_90d_cents: int | None


def get_display_timezone() -> ZoneInfo:
    """FastAPI dependency: the timezone that closes a "day" of the series."""
    return ZoneInfo(get_settings().display_timezone)


def daily_lowest(priced: Iterable[tuple[datetime, int]], tz: ZoneInfo) -> list[PricePoint]:
    """Lowest price of each local day, oldest day first; days without a price are absent."""
    lowest: dict[date, int] = {}
    for matched_at, price_cents in priced:
        day = ensure_utc(matched_at).astimezone(tz).date()
        if day not in lowest or price_cents < lowest[day]:
            lowest[day] = price_cents
    return [PricePoint(day=day, price_cents=lowest[day]) for day in sorted(lowest)]


def downsample(points: list[PricePoint], max_points: int) -> list[PricePoint]:
    """At most `max_points`, merging consecutive days into chunks by their lowest price.

    Each chunk keeps its first day, so the x axis still reads left-to-right
    in time and the lowest price of the window is never lost.
    """
    if len(points) <= max_points:
        return points
    size = math.ceil(len(points) / max_points)
    return [
        PricePoint(
            day=points[start].day,
            price_cents=min(point.price_cents for point in points[start : start + size]),
        )
        for start in range(0, len(points), size)
    ]


def price_stats(postings: list[Posting], now: datetime) -> PriceStats:
    """`postings` carry aware-UTC `matched_at` (see `load_postings`)."""
    priced = [
        (posting.matched_at, posting.id, posting.price_cents)
        for posting in postings
        if posting.price_cents is not None
    ]
    latest = max(priced, default=None)
    long_window = [price for at, _, price in priced if at >= now - STATS_LONG_WINDOW]
    short_window = [price for at, _, price in priced if at >= now - STATS_SHORT_WINDOW]
    return PriceStats(
        current_price_cents=latest[2] if latest is not None else None,
        current_price_at=latest[0] if latest is not None else None,
        lowest_90d_cents=min(long_window, default=None),
        average_30d_cents=round(sum(short_window) / len(short_window)) if short_window else None,
        highest_90d_cents=max(long_window, default=None),
    )


def series_for_range(
    postings: list[Posting], now: datetime, history_range: HistoryRange, tz: ZoneInfo
) -> list[PricePoint]:
    since = now - timedelta(days=RANGE_DAYS[history_range])
    return daily_lowest(
        (
            (posting.matched_at, posting.price_cents)
            for posting in postings
            if posting.price_cents is not None and posting.matched_at >= since
        ),
        tz,
    )


PostingIdentity = tuple[int | None, int]


def _posting_identity(
    match_id: int, source_id: int, telegram_message_id: int | None
) -> PostingIdentity:
    """One Telegram message caught by two rules is two `Match` rows but one posting.

    Rows without a Telegram id (legacy) are only ever themselves.
    """
    if telegram_message_id is None:
        return (None, match_id)
    return (source_id, telegram_message_id)


def load_postings(session: Session, key: str) -> list[Posting]:
    """Every distinct posting of `key`, newest first, in one query (with the source name).

    A message matched by several rules counts once, as its lowest-id `Match`.
    """
    rows = session.execute(
        select(
            Match.id,
            Match.source_id,
            Match.telegram_message_id,
            Source.name,
            Match.message_text,
            Match.price_cents,
            Match.matched_at,
            Match.message_link,
        )
        .join(Source, Source.id == Match.source_id)
        .where(Match.product_key == key)
        .order_by(Match.id)
    )
    seen: set[PostingIdentity] = set()
    unique_rows = []
    for row in rows:
        identity = _posting_identity(row.id, row.source_id, row.telegram_message_id)
        if identity not in seen:
            seen.add(identity)
            unique_rows.append(row)
    postings = [
        Posting(
            id=row.id,
            source_id=row.source_id,
            source_name=row.name,
            message_text=row.message_text,
            price_cents=row.price_cents,
            matched_at=ensure_utc(row.matched_at),
            message_link=row.message_link,
        )
        for row in unique_rows
    ]
    postings.sort(key=lambda posting: (posting.matched_at, posting.id), reverse=True)
    return postings


def sparklines_for_keys(
    session: Session, keys: set[str], now: datetime, tz: ZoneInfo
) -> dict[str, list[PricePoint]]:
    """90-day daily-lowest series (≤ `SPARKLINE_MAX_POINTS`) for many keys in one query."""
    if not keys:
        return {}
    statement = select(
        Match.id,
        Match.source_id,
        Match.telegram_message_id,
        Match.product_key,
        Match.matched_at,
        Match.price_cents,
    ).where(
        Match.product_key.is_not(None),
        Match.price_cents.is_not(None),
        Match.matched_at >= now - SPARKLINE_WINDOW,
    )
    if len(keys) <= _SPARKLINE_IN_LIMIT:
        statement = statement.where(Match.product_key.in_(keys))

    seen: set[PostingIdentity] = set()
    priced: dict[str, list[tuple[datetime, int]]] = {}
    for row in session.execute(statement.order_by(Match.id)):
        identity = _posting_identity(row.id, row.source_id, row.telegram_message_id)
        if identity in seen or row.product_key not in keys or row.price_cents is None:
            continue
        seen.add(identity)
        priced.setdefault(row.product_key, []).append((row.matched_at, row.price_cents))
    return {
        key: downsample(daily_lowest(rows, tz), SPARKLINE_MAX_POINTS)
        for key, rows in priced.items()
    }
