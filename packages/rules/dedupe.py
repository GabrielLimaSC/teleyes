import hashlib
import time
from collections.abc import Callable
from urllib.parse import urlparse

from packages.rules.normalize import normalize_text


def normalize_link(url: str) -> str:
    """Normalize a URL for dedupe: lowercase scheme/host, drop query/fragment/trailing slash.

    Two links to the same product that only differ by tracking params or a
    trailing slash normalize to the same value.
    """
    parsed = urlparse(url.strip())
    scheme = (parsed.scheme or "https").lower()
    netloc = parsed.netloc.lower()
    path = parsed.path.rstrip("/")
    return f"{scheme}://{netloc}{path}"


def compute_signature(
    source_id: int,
    message_text: str,
    *,
    price_cents: int | None = None,
    link: str | None = None,
    dedupe_across_sources: bool = False,
) -> str:
    """Deterministic dedupe signature over source/text/price/link.

    Reprocessing the same message (or the same promo with cosmetic differences
    like casing, accents or punctuation) always yields this exact signature.
    `link`, when present, is normalized so tracking params/trailing slashes
    don't create a false new signature. `dedupe_across_sources` implements the
    rule-level choice of whether the same promo replicated in different
    source groups should collapse into one signature (True) or dedupe only
    within each source (False, the default).
    """
    normalized_text = normalize_text(message_text)
    price_component = "" if price_cents is None else str(price_cents)
    link_component = "" if link is None else normalize_link(link)
    source_component = "" if dedupe_across_sources else str(source_id)
    payload = f"{source_component}|{normalized_text}|{price_component}|{link_component}"
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


class DedupeCache:
    """In-memory idempotency guard: a signature is only processed once per window.

    Without `window_seconds` (the default) a signature is a duplicate forever.
    With a window set, the same signature seen again after the window elapses
    is treated as a new alert (e.g. a promo that comes back after a while).
    """

    def __init__(
        self,
        window_seconds: float | None = None,
        *,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._window_seconds = window_seconds
        self._clock = clock
        self._seen: dict[str, float] = {}

    def should_process(self, signature: str) -> bool:
        now = self._clock()
        last_seen_at = self._seen.get(signature)

        if last_seen_at is not None:
            within_window = self._window_seconds is None or (
                now - last_seen_at < self._window_seconds
            )
            if within_window:
                return False

        self._seen[signature] = now
        return True
