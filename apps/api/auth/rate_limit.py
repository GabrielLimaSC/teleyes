import time
from collections.abc import Callable


class LoginRateLimiter:
    """Simple in-memory rate limiter: N failures in a window locks the key out.

    Keyed by whatever the caller wants (here, client IP) — no persistence, no
    cross-process sharing, acceptable for the same reason as `SessionStore`.
    """

    def __init__(
        self,
        max_attempts: int = 5,
        window_seconds: float = 60.0,
        lockout_seconds: float = 60.0,
        *,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._max_attempts = max_attempts
        self._window_seconds = window_seconds
        self._lockout_seconds = lockout_seconds
        self._clock = clock
        self._attempts: dict[str, list[float]] = {}
        self._locked_until: dict[str, float] = {}

    def is_locked(self, key: str) -> bool:
        locked_until = self._locked_until.get(key)
        return locked_until is not None and self._clock() < locked_until

    def record_failure(self, key: str) -> None:
        now = self._clock()
        attempts = [t for t in self._attempts.get(key, []) if now - t < self._window_seconds]
        attempts.append(now)
        self._attempts[key] = attempts
        if len(attempts) >= self._max_attempts:
            self._locked_until[key] = now + self._lockout_seconds

    def record_success(self, key: str) -> None:
        self._attempts.pop(key, None)
        self._locked_until.pop(key, None)
