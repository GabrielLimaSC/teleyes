"""S13-02: a refused/dropped Telegram connection is retried in-process.

Everything here runs against fakes (a scripted connection, a fake clock and
fake sleeps): it proves the supervisor's *logic* — never exits on a transient
failure, growing/capped/jittered backoff, escalation to `blocked` only at the
ceiling, stop during backoff/connect/startup, reason logging without leaking
exception text. It does not prove anything about the real Telegram service or
about a real sleeping/waking machine.
"""

from __future__ import annotations

import asyncio
import logging
import os
import signal
import socket
import subprocess
import sys
import time
from collections.abc import Awaitable, Callable
from pathlib import Path

import pytest
from telethon import TelegramClient
from telethon.sessions import StringSession

from packages.telegram.adapter import AdapterState, FloodWaitError, TelegramAdapter
from packages.telegram.connection_supervisor import (
    BackoffPolicy,
    ConnectionSupervisor,
    SupervisorOutcome,
    describe_error,
    is_transient_connection_error,
)

SUPERVISOR_LOGGER = "packages.telegram.connection_supervisor"


def _no_jitter(low: float, high: float) -> float:
    return 1.0


def _refused() -> ConnectionRefusedError:
    return ConnectionRefusedError(111, "Connect call failed ('149.154.175.51', 443)")


class ScriptedConnection:
    """Stands in for `TelegramAdapter`: each connect/reconnect pops one step.

    A step is an exception instance (raised), an `AdapterState` (returned) or
    `None` (connected). Calls beyond the script connect.
    """

    def __init__(self, script: list[BaseException | AdapterState | None] | None = None) -> None:
        self.script = list(script or [])
        self.connect_calls = 0
        self.reconnect_calls = 0
        self.disconnect_calls = 0

    async def _step(self) -> AdapterState:
        step = self.script.pop(0) if self.script else None
        if isinstance(step, BaseException):
            raise step
        return step or AdapterState.CONNECTED

    async def connect(self) -> AdapterState:
        self.connect_calls += 1
        return await self._step()

    async def reconnect(self) -> AdapterState:
        self.reconnect_calls += 1
        return await self._step()

    async def disconnect(self) -> None:
        self.disconnect_calls += 1


class Harness:
    """Wires a supervisor to fakes and records what it did."""

    def __init__(
        self,
        connection: ScriptedConnection,
        *,
        policy: BackoffPolicy | None = None,
        serve: Callable[[Harness], Awaitable[object]] | None = None,
        on_connected: Callable[[Harness], Awaitable[None]] | None = None,
        sleep: Callable[[float], Awaitable[None]] | None = None,
        on_blocked: Callable[[], Awaitable[None]] | None = None,
    ) -> None:
        self.stop_event = asyncio.Event()
        self.sleeps: list[float] = []
        self.connected_events = 0
        self.serve_calls = 0
        self.now = 0.0
        self._serve = serve
        self._on_connected = on_connected
        self._custom_sleep = sleep
        self.states: list[AdapterState] = []
        self.supervisor = ConnectionSupervisor(
            connection,
            wait_until_disconnected=self._wait,
            on_connected=self._connected,
            stop_event=self.stop_event,
            policy=policy or BackoffPolicy(jitter_ratio=0.0),
            sleep=self._sleep,
            monotonic=lambda: self.now,
            uniform=_no_jitter,
            on_state_change=self.states.append,
            on_blocked=on_blocked,
        )

    async def _sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        if self._custom_sleep is not None:
            await self._custom_sleep(seconds)

    async def _connected(self) -> None:
        self.connected_events += 1
        if self._on_connected is not None:
            await self._on_connected(self)

    async def _wait(self) -> object:
        self.serve_calls += 1
        if self._serve is None:
            self.stop_event.set()  # default: the first served connection ends the run
            return None
        return await self._serve(self)

    async def run(self, timeout: float = 5.0) -> SupervisorOutcome:
        return await asyncio.wait_for(self.supervisor.run(), timeout)


# ---------------------------------------------------------------- backoff policy


def test_backoff_grows_exponentially_and_is_capped() -> None:
    policy = BackoffPolicy(base_seconds=5.0, max_seconds=300.0, jitter_ratio=0.0)

    delays = [policy.delay(n, _no_jitter) for n in range(1, 10)]

    assert delays == [5, 10, 20, 40, 80, 160, 300, 300, 300]


def test_backoff_jitter_stays_within_bounds_and_never_exceeds_the_cap() -> None:
    policy = BackoffPolicy(base_seconds=5.0, max_seconds=300.0, jitter_ratio=0.2)

    assert policy.delay(3, lambda low, high: low) == pytest.approx(20 * 0.8)
    assert policy.delay(3, lambda low, high: high) == pytest.approx(20 * 1.2)
    assert policy.delay(50, lambda low, high: high) == 300.0  # jitter can't push past the cap


def test_only_network_shaped_errors_are_transient() -> None:
    assert is_transient_connection_error(ConnectionError("x"))
    assert is_transient_connection_error(_refused())
    assert is_transient_connection_error(TimeoutError())
    assert is_transient_connection_error(FloodWaitError(30))
    assert not is_transient_connection_error(RuntimeError("bug"))
    assert not is_transient_connection_error(ValueError("bug"))


def test_describe_error_never_includes_the_exception_text() -> None:
    text = describe_error(ConnectionError("token=SECRET-VALUE"))

    assert text == "error_class=ConnectionError"
    assert "SECRET" not in text
    assert describe_error(_refused()) == "error_class=ConnectionRefusedError errno=111"


# ------------------------------------------------------------- refusal handling


async def test_repeated_connection_refused_never_exits_and_backs_off_up_to_the_cap() -> None:
    connection = ScriptedConnection([_refused() for _ in range(9)])  # then it connects
    harness = Harness(connection)

    outcome = await harness.run()

    assert outcome is SupervisorOutcome.STOPPED  # ended only because the fake serve stopped it
    assert connection.connect_calls == 10  # nine refusals, then the one that connected
    assert connection.reconnect_calls == 0
    assert harness.sleeps == [5, 10, 20, 40, 80, 160, 300, 300, 300]
    assert harness.connected_events == 1
    assert AdapterState.CONNECTED in harness.states
    assert AdapterState.BLOCKED not in harness.states


async def test_reconnect_after_a_drop_uses_reconnect_and_reruns_on_connected() -> None:
    connection = ScriptedConnection([None, _refused(), _refused(), None])

    async def serve(harness: Harness) -> object:
        if harness.serve_calls == 1:
            raise ConnectionError("Connection to Telegram failed 5 time(s)")  # the S13-02 error
        harness.stop_event.set()
        return None

    harness = Harness(connection, serve=serve)

    outcome = await harness.run()

    assert outcome is SupervisorOutcome.STOPPED
    assert connection.connect_calls == 1
    assert connection.reconnect_calls == 3  # two refusals, then the one that worked
    assert harness.connected_events == 2  # boot + the reconnect
    assert harness.sleeps == [5, 10, 20]


async def test_a_serve_that_returns_without_error_is_still_treated_as_a_drop() -> None:
    connection = ScriptedConnection()

    async def serve(harness: Harness) -> object:
        if harness.serve_calls >= 2:
            harness.stop_event.set()
        return None  # Telethon's run_until_disconnected can return after a plain disconnect

    harness = Harness(connection, serve=serve)

    assert await harness.run() is SupervisorOutcome.STOPPED
    assert harness.connected_events == 2
    assert connection.reconnect_calls == 1


async def test_escalates_to_blocked_only_at_the_failure_ceiling() -> None:
    policy = BackoffPolicy(jitter_ratio=0.0, max_consecutive_failures=5)
    connection = ScriptedConnection([_refused() for _ in range(50)])
    harness = Harness(connection, policy=policy)

    outcome = await harness.run()

    assert outcome is SupervisorOutcome.BLOCKED
    assert connection.connect_calls == 5  # exactly the ceiling, not one more
    assert harness.sleeps == [5, 10, 20, 40]  # no sleep after the last failure
    assert harness.supervisor.state is AdapterState.BLOCKED
    assert connection.disconnect_calls >= 1


async def test_escalating_to_blocked_fires_on_blocked_exactly_once() -> None:
    policy = BackoffPolicy(jitter_ratio=0.0, max_consecutive_failures=5)
    connection = ScriptedConnection([_refused() for _ in range(50)])
    calls = 0

    async def on_blocked() -> None:
        nonlocal calls
        calls += 1

    harness = Harness(connection, policy=policy, on_blocked=on_blocked)

    outcome = await harness.run()

    assert outcome is SupervisorOutcome.BLOCKED
    assert calls == 1  # one alert per transition, not one per failed attempt


async def test_a_failing_on_blocked_does_not_stop_the_blocked_outcome(
    caplog: pytest.LogCaptureFixture,
) -> None:
    policy = BackoffPolicy(jitter_ratio=0.0, max_consecutive_failures=5)
    connection = ScriptedConnection([_refused() for _ in range(50)])

    async def failing_on_blocked() -> None:
        raise RuntimeError("bot also has no network")

    harness = Harness(connection, policy=policy, on_blocked=failing_on_blocked)

    with caplog.at_level(logging.ERROR, logger=SUPERVISOR_LOGGER):
        outcome = await asyncio.wait_for(harness.supervisor.run(), 5)

    assert outcome is SupervisorOutcome.BLOCKED  # the alert failing never blocks shutdown
    failures = [r for r in caplog.records if "event=blocked_alert_failed" in r.getMessage()]
    assert len(failures) == 1
    assert "error_class=RuntimeError" in failures[0].getMessage()
    assert "bot also has no network" not in caplog.text  # exception class only


async def test_no_on_blocked_configured_is_fine_too() -> None:
    policy = BackoffPolicy(jitter_ratio=0.0, max_consecutive_failures=5)
    connection = ScriptedConnection([_refused() for _ in range(50)])
    harness = Harness(connection, policy=policy)  # on_blocked defaults to None

    assert await harness.run() is SupervisorOutcome.BLOCKED


async def test_on_blocked_is_not_called_on_a_clean_stop() -> None:
    connection = ScriptedConnection()
    calls = 0

    async def on_blocked() -> None:
        nonlocal calls
        calls += 1

    harness = Harness(connection, on_blocked=on_blocked)

    assert await harness.run() is SupervisorOutcome.STOPPED
    assert calls == 0


async def test_one_failure_below_the_ceiling_still_recovers() -> None:
    policy = BackoffPolicy(jitter_ratio=0.0, max_consecutive_failures=5)
    connection = ScriptedConnection([_refused() for _ in range(4)])
    harness = Harness(connection, policy=policy)

    assert await harness.run() is SupervisorOutcome.STOPPED
    assert harness.supervisor.state is not AdapterState.BLOCKED
    assert harness.connected_events == 1


async def test_adapter_reporting_blocked_ends_without_retrying() -> None:
    connection = ScriptedConnection([AdapterState.BLOCKED])
    harness = Harness(connection)

    outcome = await harness.run()

    assert outcome is SupervisorOutcome.BLOCKED
    assert connection.connect_calls == 1
    assert harness.sleeps == []


async def test_failure_counter_resets_after_a_stable_connection() -> None:
    policy = BackoffPolicy(jitter_ratio=0.0, stable_after_seconds=60.0)
    connection = ScriptedConnection([_refused(), _refused(), None, None])

    async def serve(harness: Harness) -> object:
        if harness.serve_calls == 1:
            harness.now += 3600  # a long healthy connection, then it drops
            raise ConnectionError("dropped")
        harness.stop_event.set()
        return None

    harness = Harness(connection, policy=policy, serve=serve)

    assert await harness.run() is SupervisorOutcome.STOPPED
    # 5, 10 for the two boot refusals; after an hour of health the next failure is
    # "attempt 1" again (5), not the 4th of the streak (40).
    assert harness.sleeps == [5, 10, 5]


async def test_a_flapping_connection_does_not_reset_the_backoff() -> None:
    policy = BackoffPolicy(jitter_ratio=0.0, stable_after_seconds=60.0)
    connection = ScriptedConnection()

    async def serve(harness: Harness) -> object:
        harness.now += 1  # connected for one second, then gone
        if harness.serve_calls >= 4:
            harness.stop_event.set()
            return None
        raise ConnectionError("dropped again")

    harness = Harness(connection, policy=policy, serve=serve)

    assert await harness.run() is SupervisorOutcome.STOPPED
    assert harness.sleeps == [5, 10, 20]


async def test_flood_wait_is_honoured_when_longer_than_the_backoff() -> None:
    connection = ScriptedConnection([FloodWaitError(120)])
    harness = Harness(connection)

    assert await harness.run() is SupervisorOutcome.STOPPED
    assert harness.sleeps == [120]


async def test_a_failure_during_startup_is_retried_like_a_connection_failure() -> None:
    connection = ScriptedConnection()

    async def on_connected(harness: Harness) -> None:
        if harness.connected_events == 1:
            raise ConnectionError("dropped during the startup catch-up")

    harness = Harness(connection, on_connected=on_connected)

    assert await harness.run() is SupervisorOutcome.STOPPED
    assert harness.connected_events == 2
    assert harness.sleeps == [5]


async def test_a_non_network_error_is_not_swallowed_by_the_retry_loop() -> None:
    connection = ScriptedConnection([RuntimeError("real bug")])
    harness = Harness(connection)

    with pytest.raises(RuntimeError, match="real bug"):
        await harness.run()

    assert harness.sleeps == []
    assert connection.disconnect_calls >= 1


# ------------------------------------------------------------- shutdown (SIGTERM)


async def test_stop_during_backoff_ends_cleanly_without_another_attempt() -> None:
    connection = ScriptedConnection([_refused() for _ in range(5)])
    sleeping = asyncio.Event()

    async def blocked_sleep(seconds: float) -> None:
        sleeping.set()
        await asyncio.Event().wait()  # a backoff that would last "forever"

    harness = Harness(connection, sleep=blocked_sleep)
    task = asyncio.create_task(harness.supervisor.run())

    await asyncio.wait_for(sleeping.wait(), 2)
    harness.stop_event.set()  # what the SIGTERM handler does
    outcome = await asyncio.wait_for(task, 2)

    assert outcome is SupervisorOutcome.STOPPED
    assert connection.connect_calls == 1  # the shutdown did not turn into a retry
    assert connection.disconnect_calls >= 1


async def test_stop_during_a_hanging_connect_attempt_ends_cleanly() -> None:
    started = asyncio.Event()

    class HangingConnection(ScriptedConnection):
        async def connect(self) -> AdapterState:
            self.connect_calls += 1
            started.set()
            await asyncio.Event().wait()
            raise AssertionError("unreachable")

    connection = HangingConnection()
    harness = Harness(connection)
    task = asyncio.create_task(harness.supervisor.run())

    await asyncio.wait_for(started.wait(), 2)
    harness.stop_event.set()

    assert await asyncio.wait_for(task, 2) is SupervisorOutcome.STOPPED
    assert harness.sleeps == []


async def test_stop_during_a_long_startup_catch_up_ends_cleanly() -> None:
    connection = ScriptedConnection()
    running = asyncio.Event()
    cancelled = asyncio.Event()

    async def slow_on_connected(harness: Harness) -> None:
        running.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            cancelled.set()
            raise

    harness = Harness(connection, on_connected=slow_on_connected)
    task = asyncio.create_task(harness.supervisor.run())

    await asyncio.wait_for(running.wait(), 2)
    harness.stop_event.set()

    assert await asyncio.wait_for(task, 2) is SupervisorOutcome.STOPPED
    assert cancelled.is_set()
    assert harness.serve_calls == 0


async def test_stop_while_serving_ends_cleanly_and_disconnects() -> None:
    connection = ScriptedConnection()
    serving = asyncio.Event()

    async def serve(harness: Harness) -> object:
        serving.set()
        await asyncio.Event().wait()
        return None

    harness = Harness(connection, serve=serve)
    task = asyncio.create_task(harness.supervisor.run())

    await asyncio.wait_for(serving.wait(), 2)
    harness.stop_event.set()

    assert await asyncio.wait_for(task, 2) is SupervisorOutcome.STOPPED
    assert connection.disconnect_calls >= 1
    assert connection.reconnect_calls == 0


async def test_a_stop_requested_before_running_never_connects() -> None:
    connection = ScriptedConnection()
    harness = Harness(connection)
    harness.stop_event.set()

    assert await harness.run() is SupervisorOutcome.STOPPED
    assert connection.connect_calls == 0


# ---------------------------------------------------------------------- logging


async def test_each_reconnect_logs_reason_attempt_and_next_delay(
    caplog: pytest.LogCaptureFixture,
) -> None:
    connection = ScriptedConnection([_refused(), ConnectionError("token=SECRET-VALUE")])
    harness = Harness(connection)

    with caplog.at_level(logging.INFO, logger=SUPERVISOR_LOGGER):
        await harness.run()

    lines = [r.getMessage() for r in caplog.records if "reconnect_scheduled" in r.getMessage()]
    assert len(lines) == 2
    assert "error_class=ConnectionRefusedError errno=111" in lines[0]
    assert "attempt=1" in lines[0] and "next_delay_s=5.0" in lines[0]
    assert "error_class=ConnectionError" in lines[1]
    assert "attempt=2" in lines[1] and "next_delay_s=10.0" in lines[1]
    assert "state=reconnecting" in lines[0]
    assert "SECRET-VALUE" not in caplog.text
    assert any("event=connection_established" in r.getMessage() for r in caplog.records)


async def test_blocked_is_logged_loudly_with_the_failure_count(
    caplog: pytest.LogCaptureFixture,
) -> None:
    policy = BackoffPolicy(jitter_ratio=0.0, max_consecutive_failures=2)
    harness = Harness(ScriptedConnection([_refused(), _refused()]), policy=policy)

    with caplog.at_level(logging.INFO, logger=SUPERVISOR_LOGGER):
        await harness.run()

    blocked = [r for r in caplog.records if "event=blocked" in r.getMessage()]
    assert len(blocked) == 1
    assert blocked[0].levelno == logging.ERROR
    assert "consecutive_failures=2" in blocked[0].getMessage()
    assert "error_class=ConnectionRefusedError" in blocked[0].getMessage()


# --------------------------------------------- real Telethon client, no Telegram


def _closed_local_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])  # released on exit: nothing listens there


async def test_a_real_telethon_client_refused_by_the_server_is_retried_not_fatal(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The exact exception chain from the production log, produced by the real
    Telethon library against a closed local port (no network, no credentials):
    `ConnectionRefusedError` x N -> `ConnectionError: Connection to Telegram
    failed`. Proves the supervisor keeps going through the *real* exception
    class, not only through one our own fake raises.
    """
    client = TelegramClient(StringSession(), 12345, "0" * 32, connection_retries=1, retry_delay=0)
    client.session.set_dc(2, "127.0.0.1", _closed_local_port())
    adapter = TelegramAdapter(api_id=12345, api_hash="0" * 32, client=client, sleep=asyncio.sleep)
    stop_event = asyncio.Event()
    sleeps: list[float] = []

    async def stop_after_three_backoffs(seconds: float) -> None:
        sleeps.append(seconds)
        if len(sleeps) == 3:
            stop_event.set()

    supervisor = ConnectionSupervisor(
        adapter,
        wait_until_disconnected=client.run_until_disconnected,
        on_connected=_never_connected,
        stop_event=stop_event,
        policy=BackoffPolicy(jitter_ratio=0.0),
        sleep=stop_after_three_backoffs,
    )

    with caplog.at_level(logging.INFO, logger=SUPERVISOR_LOGGER):
        outcome = await asyncio.wait_for(supervisor.run(), 30)

    assert outcome is SupervisorOutcome.STOPPED
    assert sleeps == [5, 10, 20]
    reasons = [r.getMessage() for r in caplog.records if "reconnect_scheduled" in r.getMessage()]
    assert len(reasons) == 3
    assert all("error_class=ConnectionError" in reason for reason in reasons)


async def _never_connected() -> None:
    raise AssertionError("the closed port must never yield a connection")


# ------------------------------------------ real SIGTERM, real process (S5-09/S13-02)

_SIGTERM_HARNESS = """
import asyncio, sys
from packages.telegram.adapter import AdapterState
from packages.telegram.connection_supervisor import (
    BackoffPolicy, ConnectionSupervisor, SupervisorOutcome, install_stop_signal_handlers,
)


class AlwaysRefused:
    async def connect(self):
        raise ConnectionRefusedError(111, "refused")

    async def reconnect(self):
        raise ConnectionRefusedError(111, "refused")

    async def disconnect(self):
        pass


async def never():
    raise AssertionError("must not run")


async def main():
    stop = asyncio.Event()
    install_stop_signal_handlers(asyncio.get_running_loop(), stop)

    async def announce_then_sleep(seconds):
        print("backing-off", seconds, flush=True)
        await asyncio.sleep(seconds)

    supervisor = ConnectionSupervisor(
        AlwaysRefused(),
        wait_until_disconnected=never,
        on_connected=never,
        stop_event=stop,
        policy=BackoffPolicy(base_seconds=60.0, jitter_ratio=0.0),
        sleep=announce_then_sleep,
    )
    outcome = await supervisor.run()
    print("outcome", outcome.value, flush=True)
    return 0 if outcome is SupervisorOutcome.STOPPED else 1


sys.exit(asyncio.run(main()))
"""


@pytest.mark.parametrize("signal_number", [signal.SIGTERM, signal.SIGINT])
def test_a_real_signal_during_backoff_ends_the_process_cleanly_and_fast(
    signal_number: int,
) -> None:
    repo_root = Path(__file__).resolve().parents[3]
    process = subprocess.Popen(
        [sys.executable, "-c", _SIGTERM_HARNESS],
        cwd=repo_root,
        env={**os.environ, "PYTHONPATH": str(repo_root)},
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
    )
    try:
        assert process.stdout is not None
        # Wait until it really is inside a 60s backoff, then signal it.
        assert process.stdout.readline().startswith("backing-off")
        started = time.monotonic()
        process.send_signal(signal_number)
        exit_code = process.wait(timeout=10)
        elapsed = time.monotonic() - started
        rest = process.stdout.read()
    finally:
        if process.poll() is None:
            process.kill()

    assert exit_code == 0  # clean stop, not a crash (and not a retry loop)
    assert "outcome stopped" in rest
    assert "backing-off" not in rest  # the signal did not trigger another attempt
    assert elapsed < 5  # nowhere near the 60s backoff
