from __future__ import annotations

from collections.abc import AsyncIterator, Sequence

from packages.telegram.adapter import BlockedError, FloodWaitError
from packages.telegram.cursor import TelegramMessage


class FakeTelegramClient:
    """Scripted client for exercising TelegramAdapter without a real Telegram session.

    `script` lists what each successive `connect()` call should do:
    `None` means "succeed", a `float` raises `FloodWaitError(seconds)`, and the
    string `"blocked"` raises `BlockedError`. Calls beyond the script succeed.

    `messages` seeds the backlog `iter_messages` serves — simulating history the
    real Telegram history API would return, including messages that arrived
    while the adapter was disconnected.
    """

    def __init__(
        self,
        script: Sequence[float | str | None] = (),
        messages: Sequence[TelegramMessage] = (),
    ) -> None:
        self._script = list(script)
        self.messages = list(messages)
        self.connect_calls = 0
        self.disconnect_calls = 0

    async def connect(self) -> None:
        self.connect_calls += 1
        step = self._script.pop(0) if self._script else None
        if step is None:
            return
        if step == "blocked":
            raise BlockedError
        raise FloodWaitError(float(step))

    async def disconnect(self) -> None:
        self.disconnect_calls += 1

    async def iter_messages(
        self, chat_id: str, *, min_id: int, limit: int
    ) -> AsyncIterator[TelegramMessage]:
        for message in sorted(self.messages, key=lambda m: m.id):
            if message.id > min_id:
                yield message

    async def iter_recent(self, chat_id: str) -> AsyncIterator[TelegramMessage]:
        """Newest-to-oldest, like the real Telegram history API's default order —
        exercises `packages.telegram.historical.fetch_messages_since` (S6-02)
        without any `min_id`/`limit` bound.
        """
        for message in sorted(self.messages, key=lambda m: m.id, reverse=True):
            yield message
