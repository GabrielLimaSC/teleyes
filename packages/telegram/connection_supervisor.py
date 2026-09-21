"""Keep the Telegram connection alive inside the process (S13-02).

Real evidence behind this module (docker logs of `teleyes-dev-listener-1`, 17
restarts in ~33h, always during Mac DarkWake cycles): Telethon gives up after
its own short retry budget (`connection_retries=5`, fixed 1s `retry_delay`, ~7s
per cycle) and surfaces `ConnectionError: Connection to Telegram failed 5
time(s)` in two places our old code let escape:

- at boot, out of `adapter.connect()` (uncaught -> exit code 1);
- while running, out of `client.run_until_disconnected()`, whose exception was
  parked in a task nobody awaited (`Task exception was never retrieved`) while
  `main()` returned normally (exit code 0).

Either way the process ended, Docker restarted it, and every restart repeated
the full 7-day historical scan. Here a connection failure is a *state*, not an
exit: reconnect with exponential backoff (jittered, capped), log why, and only
after a ceiling of consecutive failures escalate to `blocked` and give up.

Telethon-agnostic on purpose (same style as `adapter.py`): it drives any object
with `connect()`/`reconnect()`/`disconnect()` and any awaitable that resolves
or raises when the link goes away.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import random
import signal
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from enum import StrEnum
from typing import Protocol, TypeVar

from packages.telegram.adapter import AdapterState, SleepFn

logger = logging.getLogger(__name__)

T = TypeVar("T")

DISCONNECT_TIMEOUT_SECONDS = 10.0


class SupervisorOutcome(StrEnum):
    STOPPED = "stopped"
    BLOCKED = "blocked"


class ManagedConnection(Protocol):
    """The slice of `TelegramAdapter` the supervisor drives."""

    async def connect(self) -> AdapterState: ...

    async def reconnect(self) -> AdapterState: ...

    async def disconnect(self) -> None: ...


@dataclass(frozen=True)
class BackoffPolicy:
    """Exponential backoff with jitter and a ceiling on consecutive failures.

    `max_consecutive_failures` counts failures with no stable connection in
    between; with the defaults (5s doubling to a 300s cap) 30 failures is a bit
    over two hours of continuous outage. It counts failures rather than
    measuring wall-clock time on purpose: a Mac that sleeps for a night must not
    look like "hours of failing" the instant it wakes up.
    """

    base_seconds: float = 5.0
    factor: float = 2.0
    max_seconds: float = 300.0
    jitter_ratio: float = 0.2
    max_consecutive_failures: int = 30
    stable_after_seconds: float = 60.0

    def delay(self, failure_number: int, uniform: Callable[[float, float], float]) -> float:
        exponent = min(max(failure_number - 1, 0), 64)
        capped = min(self.base_seconds * self.factor**exponent, self.max_seconds)
        jittered = capped * uniform(1 - self.jitter_ratio, 1 + self.jitter_ratio)
        return min(jittered, self.max_seconds)


def is_transient_connection_error(error: BaseException) -> bool:
    """Network-shaped failures that are worth retrying.

    `ConnectionError` and `TimeoutError` are `OSError` subclasses; `EOFError`
    covers a peer closing mid-read. Anything else (a bug, a revoked session)
    must not be retried in a loop that hides it.
    """
    return isinstance(error, OSError | EOFError) or flood_wait_seconds(error) is not None


def flood_wait_seconds(error: BaseException) -> float | None:
    """Seconds Telegram asked us to wait, for a Telethon/adapter FloodWait error."""
    seconds = getattr(error, "seconds", None)
    if "FloodWait" in type(error).__name__ and isinstance(seconds, int | float):
        return float(seconds)
    return None


def describe_error(error: BaseException | None) -> str:
    """Class (and errno, when there is one) only — never `str(error)`.

    Exception messages can embed addresses or request details; the class is
    what tells us why the connection went away.
    """
    if error is None:
        return "error_class=none"
    text = f"error_class={type(error).__name__}"
    errno = getattr(error, "errno", None)
    if isinstance(errno, int):
        text += f" errno={errno}"
    return text


def install_stop_signal_handlers(
    loop: asyncio.AbstractEventLoop, stop_event: asyncio.Event
) -> None:
    """SIGTERM/SIGINT only set `stop_event`; nothing here can raise.

    Required for PID 1 (S5-09): the kernel drops the default action of an
    unhandled signal for PID 1, so `docker stop` would otherwise wait out the
    grace period and end in SIGKILL.
    """
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop_event.set)


class _Stopped:
    """Sentinel: shutdown was requested while an awaitable was in flight."""


STOPPED = _Stopped()


class ConnectionSupervisor:
    """Connect, serve until the link drops, back off, repeat; stop on request.

    `on_connected` runs after every successful connection, first one included
    (the caller distinguishes boot from reconnect — see
    `app.listener_lifecycle.ListenerLifecycle`). `wait_until_disconnected` must
    resolve or raise when the connection is lost (Telethon's
    `run_until_disconnected`). Everything awaited here is raced against
    `stop_event`, so a SIGTERM during a connect attempt, a backoff sleep or a
    long catch-up ends the run cleanly instead of being ignored until Docker
    escalates to SIGKILL — and a requested stop is never mistaken for a
    failure to retry.
    """

    def __init__(
        self,
        connection: ManagedConnection,
        *,
        wait_until_disconnected: Callable[[], Awaitable[object]],
        on_connected: Callable[[], Awaitable[None]],
        stop_event: asyncio.Event,
        policy: BackoffPolicy | None = None,
        sleep: SleepFn = asyncio.sleep,
        monotonic: Callable[[], float] = time.monotonic,
        uniform: Callable[[float, float], float] = random.uniform,
        on_state_change: Callable[[AdapterState], None] | None = None,
    ) -> None:
        self._connection = connection
        self._wait_until_disconnected = wait_until_disconnected
        self._on_connected = on_connected
        self._stop = stop_event
        self._policy = policy or BackoffPolicy()
        self._sleep = sleep
        self._monotonic = monotonic
        self._uniform = uniform
        self._on_state_change = on_state_change
        self.state: AdapterState = AdapterState.CONNECTING
        self.backoff_delays: list[float] = []

    def _set_state(self, state: AdapterState) -> None:
        self.state = state
        if self._on_state_change is not None:
            self._on_state_change(state)

    async def run(self) -> SupervisorOutcome:
        failures = 0
        connected_before = False

        while not self._stop.is_set():
            self._set_state(
                AdapterState.RECONNECTING if connected_before else AdapterState.CONNECTING
            )
            connected_at: float | None = None
            phase = "connect"
            error: BaseException | None = None
            try:
                establish = (
                    self._connection.reconnect if connected_before else self._connection.connect
                )
                result = await self._until_stopped(establish())
                if isinstance(result, _Stopped):
                    break
                if result is AdapterState.BLOCKED:
                    return await self._block("adapter_blocked", failures)
                if result is not AdapterState.CONNECTED:
                    return await self._block(f"unexpected_state={result.value}", failures)

                connected_before = True
                connected_at = self._monotonic()
                self._set_state(AdapterState.CONNECTED)
                logger.info(
                    "event=connection_established state=connected consecutive_failures=%d",
                    failures,
                )

                phase = "startup"
                if isinstance(await self._until_stopped(self._on_connected()), _Stopped):
                    break

                phase = "serve"
                if isinstance(await self._until_stopped(self._wait_until_disconnected()), _Stopped):
                    break
            except Exception as caught:
                if not is_transient_connection_error(caught):
                    logger.error("event=fatal_error phase=%s %s", phase, describe_error(caught))
                    await self._safe_disconnect()
                    raise
                error = caught

            if connected_at is not None and (
                self._monotonic() - connected_at >= self._policy.stable_after_seconds
            ):
                failures = 0
            failures += 1
            await self._safe_disconnect()

            if failures >= self._policy.max_consecutive_failures:
                return await self._block(describe_error(error), failures)

            delay = self._policy.delay(failures, self._uniform)
            requested = flood_wait_seconds(error) if error is not None else None
            if requested is not None:
                delay = max(delay, requested)
            self.backoff_delays.append(delay)
            self._set_state(AdapterState.RECONNECTING)
            logger.warning(
                "event=reconnect_scheduled state=reconnecting phase=%s %s attempt=%d "
                "next_delay_s=%.1f",
                phase,
                describe_error(error),
                failures,
                delay,
            )
            if isinstance(await self._until_stopped(self._sleep(delay)), _Stopped):
                break

        await self._safe_disconnect()
        logger.info("event=stopped state=%s", self.state.value)
        return SupervisorOutcome.STOPPED

    async def _block(self, reason: str, failures: int) -> SupervisorOutcome:
        self._set_state(AdapterState.BLOCKED)
        await self._safe_disconnect()
        logger.error(
            "event=blocked state=blocked reason=%s consecutive_failures=%d — desistindo; "
            "o processo encerra e o Docker o reinicia.",
            reason,
            failures,
        )
        return SupervisorOutcome.BLOCKED

    async def _safe_disconnect(self) -> None:
        try:
            await asyncio.wait_for(self._connection.disconnect(), DISCONNECT_TIMEOUT_SECONDS)
        except Exception as caught:
            logger.debug("event=disconnect_failed %s", describe_error(caught))

    async def _until_stopped(self, awaitable: Awaitable[T]) -> T | _Stopped:
        """Await `awaitable`, unless shutdown is requested first (then cancel it)."""
        work = asyncio.ensure_future(awaitable)
        stop_wait = asyncio.ensure_future(self._stop.wait())
        try:
            await asyncio.wait({work, stop_wait}, return_when=asyncio.FIRST_COMPLETED)
        except asyncio.CancelledError:
            work.cancel()
            raise
        finally:
            stop_wait.cancel()
        if self._stop.is_set():
            # A requested stop wins even if the work finished (or failed) at the
            # same moment: e.g. Telethon's `run_until_disconnected` returns *because*
            # we are shutting down, which must not read as a dropped connection.
            if not work.done():
                work.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await work
            return STOPPED
        return work.result()
