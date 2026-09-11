import hashlib

from packages.rules.normalize import normalize_text


def compute_signature(source_id: int, message_text: str, price_cents: int | None = None) -> str:
    """Deterministic dedupe signature: same source/normalized text/price -> same hash.

    Reprocessing the same message (or the same promo with cosmetic differences
    like casing, accents or punctuation) always yields this exact signature.
    """
    normalized_text = normalize_text(message_text)
    price_component = "" if price_cents is None else str(price_cents)
    payload = f"{source_id}|{normalized_text}|{price_component}"
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


class DedupeCache:
    """In-memory idempotency guard: a signature is only processed once."""

    def __init__(self) -> None:
        self._seen: set[str] = set()

    def should_process(self, signature: str) -> bool:
        if signature in self._seen:
            return False
        self._seen.add(signature)
        return True
