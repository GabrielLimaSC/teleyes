from __future__ import annotations

from collections.abc import AsyncIterator, Sequence

from packages.telegram.adapter import BlockedError, FloodWaitError
from packages.telegram.cursor import TelegramMessage


class FakeTelegramClient:
    """Scripted client for exercising TelegramAdapter without a real Telegram session.

    `script` lists what each successive `connect()` call should do:
    `None` means "succeed", a `float` raises `FloodWaitError(seconds)`, the
    string `"blocked"` raises `BlockedError`, and an exception instance is raised
    as is (e.g. `ConnectionRefusedError`, S13-02). Calls beyond the script succeed.

    `messages` seeds the backlog `iter_messages` serves — simulating history the
    real Telegram history API would return, including messages that arrived
    while the adapter was disconnected.
    """

    def __init__(
        self,
        script: Sequence[float | str | BaseException | None] = (),
        messages: Sequence[TelegramMessage] = (),
    ) -> None:
        self._script = list(script)
        self.messages = list(messages)
        self.connect_calls = 0
        self.disconnect_calls = 0
        # Fetch bookkeeping, for asserting *how* history was read (S13-02).
        self.iter_messages_min_ids: list[int] = []
        self.iter_recent_calls = 0
        # Network failures to raise from the next N fetches (`ConnectionError`).
        self.iter_messages_failures = 0
        self.iter_recent_failures = 0

    async def connect(self) -> None:
        self.connect_calls += 1
        step = self._script.pop(0) if self._script else None
        if step is None:
            return
        if isinstance(step, BaseException):
            raise step
        if step == "blocked":
            raise BlockedError
        raise FloodWaitError(float(step))

    async def disconnect(self) -> None:
        self.disconnect_calls += 1

    async def iter_messages(
        self, chat_id: str, *, min_id: int, limit: int
    ) -> AsyncIterator[TelegramMessage]:
        self.iter_messages_min_ids.append(min_id)
        if self.iter_messages_failures > 0:
            self.iter_messages_failures -= 1
            raise ConnectionError("Connection to Telegram failed 5 time(s)")
        for message in sorted(self.messages, key=lambda m: m.id):
            if message.id > min_id:
                yield message

    async def iter_recent(self, chat_id: str) -> AsyncIterator[TelegramMessage]:
        """Newest-to-oldest, like the real Telegram history API's default order —
        exercises `packages.telegram.historical.fetch_messages_since` (S6-02)
        without any `min_id`/`limit` bound.
        """
        self.iter_recent_calls += 1
        if self.iter_recent_failures > 0:
            self.iter_recent_failures -= 1
            raise ConnectionError("Connection to Telegram failed 5 time(s)")
        for message in sorted(self.messages, key=lambda m: m.id, reverse=True):
            yield message
