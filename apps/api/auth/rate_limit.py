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


class EscalatingRateLimiter:
    """S19-02: lock-out with exponential backoff, for the setup wizard.

    The wizard drives a real Telegram account, so a stolen dashboard cookie must not
    turn the api into a brute-force oracle against it. `max_failures` failures inside
    `window_seconds` lock the key for `base_lockout_seconds`; each further lock-out
    doubles, up to `max_lockout_seconds`. A success resets the strikes. The key is
    the *action* (not the client address): there is one administrator, and behind a
    reverse proxy every client shares one address anyway.
    """

    def __init__(
        self,
        max_failures: int = 5,
        window_seconds: float = 600.0,
        base_lockout_seconds: float = 60.0,
        max_lockout_seconds: float = 3600.0,
        *,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._max_failures = max_failures
        self._window_seconds = window_seconds
        self._base_lockout_seconds = base_lockout_seconds
        self._max_lockout_seconds = max_lockout_seconds
        self._clock = clock
        self._failures: dict[str, list[float]] = {}
        self._strikes: dict[str, int] = {}
        self._locked_until: dict[str, float] = {}

    def retry_after(self, key: str) -> int:
        """Seconds until the key is usable again; 0 when it is not locked."""
        locked_until = self._locked_until.get(key)
        if locked_until is None:
            return 0
        remaining = locked_until - self._clock()
        return int(remaining) + 1 if remaining > 0 else 0

    def is_locked(self, key: str) -> bool:
        return self.retry_after(key) > 0

    def record_failure(self, key: str) -> None:
        now = self._clock()
        recent = [t for t in self._failures.get(key, []) if now - t < self._window_seconds]
        recent.append(now)
        self._failures[key] = recent
        if len(recent) >= self._max_failures:
            strikes = self._strikes.get(key, 0)
            lockout = min(self._base_lockout_seconds * (2**strikes), self._max_lockout_seconds)
            self._locked_until[key] = now + lockout
            self._strikes[key] = strikes + 1
            self._failures[key] = []

    def record_success(self, key: str) -> None:
        self._failures.pop(key, None)
        self._strikes.pop(key, None)
        self._locked_until.pop(key, None)
