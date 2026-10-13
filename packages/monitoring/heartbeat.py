from __future__ import annotations

import asyncio
import logging
import os
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from urllib.request import Request, urlopen

logger = logging.getLogger(__name__)

DEFAULT_INTERVAL_SECONDS = 300.0
REQUEST_TIMEOUT_SECONDS = 5.0

HeartbeatSender = Callable[[str, float], Awaitable[None]]
HealthCheck = Callable[[], bool]
IntervalWaiter = Callable[[asyncio.Event, float], Awaitable[None]]


@dataclass(frozen=True)
class HeartbeatConfig:
    url: str | None
    interval_seconds: float = DEFAULT_INTERVAL_SECONDS
    timeout_seconds: float = REQUEST_TIMEOUT_SECONDS

    @property
    def enabled(self) -> bool:
        return bool(self.url and self.url.strip())


def load_heartbeat_config(environment: Mapping[str, str] | None = None) -> HeartbeatConfig:
    """Load the optional heartbeat without ever logging its sensitive URL."""
    values = os.environ if environment is None else environment
    url = values.get("HEARTBEAT_URL", "").strip() or None
    raw_interval = values.get("HEARTBEAT_INTERVAL_SECONDS", "").strip()

    if not raw_interval:
        interval = DEFAULT_INTERVAL_SECONDS
    else:
        try:
            interval = float(raw_interval)
            if interval <= 0:
                raise ValueError
        except ValueError:
            logger.warning(
                "HEARTBEAT_INTERVAL_SECONDS inválido; usando o padrão de %.0f segundos.",
                DEFAULT_INTERVAL_SECONDS,
            )
            interval = DEFAULT_INTERVAL_SECONDS

    return HeartbeatConfig(url=url, interval_seconds=interval)


class HttpHeartbeatSender:
    """Send an empty POST; the configured URL is the only identifying value."""

    async def __call__(self, url: str, timeout_seconds: float) -> None:
        await asyncio.to_thread(self._send, url, timeout_seconds)

    @staticmethod
    def _send(url: str, timeout_seconds: float) -> None:
        request = Request(url, data=b"", method="POST")  # noqa: S310 (configured URL)
        response = urlopen(request, timeout=timeout_seconds)  # noqa: S310 (configured URL)
        response.close()


async def _wait_for_interval(stop_event: asyncio.Event, seconds: float) -> None:
    try:
        await asyncio.wait_for(stop_event.wait(), timeout=seconds)
    except TimeoutError:
        pass


async def run_heartbeat(
    config: HeartbeatConfig,
    is_healthy: HealthCheck,
    stop_event: asyncio.Event,
    *,
    sender: HeartbeatSender | None = None,
    wait_for_interval: IntervalWaiter = _wait_for_interval,
) -> None:
    """Ping periodically only while the listener's real client is connected.

    External failures are deliberately isolated from the listener. Exception
    details are not logged because HTTP client errors commonly embed the full
    request URL, whose path may contain the heartbeat service's secret key.
    """
    if not config.enabled:
        return

    assert config.url is not None
    url = config.url
    send = sender or HttpHeartbeatSender()
    logger.info(
        "Heartbeat externo habilitado (intervalo: %.1f segundos).",
        config.interval_seconds,
    )

    while not stop_event.is_set():
        if is_healthy():
            try:
                await send(url, config.timeout_seconds)
            except Exception:
                logger.warning(
                    "Falha ao enviar heartbeat externo; nova tentativa no próximo intervalo."
                )

        await wait_for_interval(stop_event, config.interval_seconds)
