"""S17-10: the one place that says how long a price-target hit stays "live".

A promotion older than this window has already expired in practice, so the
read side (`MatchResponse.target_hit`/`target_gap_pct`, the feed pin, the
per-rule `lowest_price_24h_cents`) only counts offers inside it. Sending the
target alert (`app.pipeline`) never consults this: that decision stays the
pure `packages.rules.target.target_hit` on the fresh message.
"""

from datetime import datetime, timedelta

from app.utc import ensure_utc

TARGET_HIT_WINDOW = timedelta(hours=24)


def target_window_start(now: datetime) -> datetime:
    """Oldest `matched_at` (aware UTC) that still counts as a live offer."""
    return ensure_utc(now) - TARGET_HIT_WINDOW


def within_target_window(matched_at: datetime, now: datetime) -> bool:
    return ensure_utc(matched_at) >= target_window_start(now)
