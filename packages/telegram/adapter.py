from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from enum import StrEnum
from typing import Protocol

logger = logging.getLogger(__name__)

SleepFn = Callable[[float], Awaitable[None]]


class AdapterState(StrEnum):
    NOT_CONFIGURED = "not_configured"
    CONNECTING = "connecting"
    CONNECTED = "connected"
    RECONNECTING = "reconnecting"
    BLOCKED = "blocked"


class FloodWaitError(Exception):
    """Raised by a client when Telegram asks to wait before retrying."""

    def __init__(self, seconds: float) -> None:
        super().__init__(f"flood wait: {seconds}s")
        self.seconds = seconds


class BlockedError(Exception):
    """Raised by a client when the account is banned, deactivated or revoked."""


class TelegramClientProtocol(Protocol):
    async def connect(self) -> None: ...

    async def disconnect(self) -> None: ...


class TelegramAdapter:
    """State machine wrapping a Telethon-compatible client.

    Without TG_API_ID/TG_API_HASH the adapter never touches the client and stays
    `not_configured`. With a client injected, `connect`/`reconnect` walk through
    `connecting`/`reconnecting`, applying exponential backoff on flood-wait until
    the client connects or reports a permanent block.
    """

    def __init__(
        self,
        api_id: int | None,
        api_hash: str | None,
        client: TelegramClientProtocol | None,
        sleep: SleepFn,
        max_attempts: int = 5,
        base_backoff_seconds: float = 1.0,
        max_backoff_seconds: float = 60.0,
    ) -> None:
        self._api_id = api_id
        self._api_hash = api_hash
        self._client = client
        self._sleep = sleep
        self._max_attempts = max_attempts
        self._base_backoff_seconds = base_backoff_seconds
        self._max_backoff_seconds = max_backoff_seconds
        self.state: AdapterState = AdapterState.NOT_CONFIGURED
        self.backoff_delays: list[float] = []

    def is_configured(self) -> bool:
        return self._api_id is not None and bool(self._api_hash)

    async def connect(self) -> AdapterState:
        return await self._establish(AdapterState.CONNECTING)

    async def reconnect(self) -> AdapterState:
        return await self._establish(AdapterState.RECONNECTING)

    async def _establish(self, attempting_state: AdapterState) -> AdapterState:
        if not self.is_configured():
            self.state = AdapterState.NOT_CONFIGURED
            return self.state

        assert self._client is not None, "configured adapter requires a client"

        self.state = attempting_state
        for attempt in range(self._max_attempts):
            try:
                await self._client.connect()
            except FloodWaitError as error:
                self.state = AdapterState.RECONNECTING
                delay = self._backoff_delay(attempt, error.seconds)
                self.backoff_delays.append(delay)
                await self._sleep(delay)
            except BlockedError:
                self.state = AdapterState.BLOCKED
                return self.state
            else:
                self.state = AdapterState.CONNECTED
                return self.state

        self.state = AdapterState.BLOCKED
        return self.state

    def _backoff_delay(self, attempt: int, requested_seconds: float) -> float:
        exponential = self._base_backoff_seconds * (2**attempt)
        return min(max(requested_seconds, exponential), self._max_backoff_seconds)

    async def disconnect(self) -> None:
        if self._client is not None:
            await self._client.disconnect()
        if self.state != AdapterState.NOT_CONFIGURED:
            self.state = AdapterState.RECONNECTING
