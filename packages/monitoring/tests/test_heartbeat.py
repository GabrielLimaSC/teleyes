import asyncio
import logging
from collections.abc import Callable
from email.message import Message
from urllib.error import HTTPError
from urllib.request import Request

import pytest

from packages.monitoring.heartbeat import (
    DEFAULT_INTERVAL_SECONDS,
    HeartbeatConfig,
    HttpHeartbeatSender,
    load_heartbeat_config,
    run_heartbeat,
)

SECRET_URL = "https://heartbeat.invalid/secret-monitor-key"


class ControlledWaiter:
    def __init__(self, stop_after: int) -> None:
        self.stop_after = stop_after
        self.intervals: list[float] = []

    async def __call__(self, stop_event: asyncio.Event, seconds: float) -> None:
        self.intervals.append(seconds)
        if len(self.intervals) >= self.stop_after:
            stop_event.set()


@pytest.mark.parametrize("environment", [{}, {"HEARTBEAT_URL": "   "}])
def test_load_config_disables_heartbeat_without_url(environment: dict[str, str]) -> None:
    config = load_heartbeat_config(environment)

    assert config.enabled is False
    assert config.interval_seconds == DEFAULT_INTERVAL_SECONDS


def test_load_config_accepts_custom_interval() -> None:
    config = load_heartbeat_config(
        {"HEARTBEAT_URL": SECRET_URL, "HEARTBEAT_INTERVAL_SECONDS": "12.5"}
    )

    assert config.enabled is True
    assert config.interval_seconds == 12.5


@pytest.mark.asyncio
@pytest.mark.parametrize("url", [None, ""])
async def test_disabled_heartbeat_makes_no_request(url: str | None) -> None:
    calls: list[str] = []

    async def sender(url: str, timeout: float) -> None:
        calls.append(url)

    await run_heartbeat(
        HeartbeatConfig(url=url),
        lambda: True,
        asyncio.Event(),
        sender=sender,
    )

    assert calls == []


@pytest.mark.asyncio
async def test_connected_listener_pings_periodically_at_configured_interval() -> None:
    calls: list[tuple[str, float]] = []
    stop_event = asyncio.Event()
    waiter = ControlledWaiter(stop_after=3)

    async def sender(url: str, timeout: float) -> None:
        calls.append((url, timeout))

    await run_heartbeat(
        HeartbeatConfig(url=SECRET_URL, interval_seconds=1.25, timeout_seconds=2.0),
        lambda: True,
        stop_event,
        sender=sender,
        wait_for_interval=waiter,
    )

    assert calls == [(SECRET_URL, 2.0)] * 3
    assert waiter.intervals == [1.25, 1.25, 1.25]


@pytest.mark.asyncio
async def test_disconnected_listener_does_not_ping() -> None:
    calls: list[str] = []
    stop_event = asyncio.Event()

    async def sender(url: str, timeout: float) -> None:
        calls.append(url)

    await run_heartbeat(
        HeartbeatConfig(url=SECRET_URL),
        lambda: False,
        stop_event,
        sender=sender,
        wait_for_interval=ControlledWaiter(stop_after=2),
    )

    assert calls == []


@pytest.mark.asyncio
async def test_heartbeat_resumes_after_reconnection() -> None:
    states = iter([True, False, True])
    calls: list[str] = []
    stop_event = asyncio.Event()

    async def sender(url: str, timeout: float) -> None:
        calls.append(url)

    await run_heartbeat(
        HeartbeatConfig(url=SECRET_URL),
        lambda: next(states),
        stop_event,
        sender=sender,
        wait_for_interval=ControlledWaiter(stop_after=3),
    )

    assert calls == [SECRET_URL, SECRET_URL]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "failure_factory",
    [
        lambda: RuntimeError("network unavailable"),
        lambda: HTTPError(SECRET_URL, 503, "unavailable", Message(), None),
    ],
)
async def test_external_failure_is_sanitized_and_does_not_stop_loop(
    failure_factory: Callable[[], Exception], caplog: pytest.LogCaptureFixture
) -> None:
    attempts = 0
    stop_event = asyncio.Event()

    async def sender(url: str, timeout: float) -> None:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise failure_factory()

    with caplog.at_level(logging.WARNING):
        await run_heartbeat(
            HeartbeatConfig(url=SECRET_URL),
            lambda: True,
            stop_event,
            sender=sender,
            wait_for_interval=ControlledWaiter(stop_after=2),
        )

    assert attempts == 2
    assert "nova tentativa" in caplog.text
    assert SECRET_URL not in caplog.text
    assert "secret-monitor-key" not in caplog.text


@pytest.mark.asyncio
async def test_stop_event_interrupts_long_interval() -> None:
    stop_event = asyncio.Event()

    async def sender(url: str, timeout: float) -> None:
        stop_event.set()

    await asyncio.wait_for(
        run_heartbeat(
            HeartbeatConfig(url=SECRET_URL, interval_seconds=3600),
            lambda: True,
            stop_event,
            sender=sender,
        ),
        timeout=0.5,
    )


@pytest.mark.asyncio
async def test_cancellation_propagates() -> None:
    started = asyncio.Event()

    async def sender(url: str, timeout: float) -> None:
        started.set()
        await asyncio.Event().wait()

    task = asyncio.create_task(
        run_heartbeat(
            HeartbeatConfig(url=SECRET_URL),
            lambda: True,
            asyncio.Event(),
            sender=sender,
        )
    )
    await started.wait()
    task.cancel()

    with pytest.raises(asyncio.CancelledError):
        await task


@pytest.mark.asyncio
async def test_http_sender_posts_empty_body_with_explicit_timeout(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    requests: list[tuple[Request, float]] = []

    class Response:
        def close(self) -> None:
            pass

    def fake_urlopen(request: Request, *, timeout: float) -> Response:
        requests.append((request, timeout))
        return Response()

    monkeypatch.setattr("packages.monitoring.heartbeat.urlopen", fake_urlopen)

    await HttpHeartbeatSender()(SECRET_URL, 1.0)

    request, timeout = requests[0]
    assert request.method == "POST"
    assert request.data == b""
    assert timeout == 1.0
