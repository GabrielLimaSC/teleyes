from __future__ import annotations

from collections.abc import Sequence

from packages.telegram.adapter import BlockedError, FloodWaitError


class FakeTelegramClient:
    """Scripted client for exercising TelegramAdapter without a real Telegram session.

    `script` lists what each successive `connect()` call should do:
    `None` means "succeed", a `float` raises `FloodWaitError(seconds)`, and the
    string `"blocked"` raises `BlockedError`. Calls beyond the script succeed.
    """

    def __init__(self, script: Sequence[float | str | None] = ()) -> None:
        self._script = list(script)
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
