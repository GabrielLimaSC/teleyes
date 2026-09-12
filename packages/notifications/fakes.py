from collections.abc import Container


class FakeBotClient:
    """Records every message it would have sent, for assertions in tests.

    `fail_for_chat_ids` simulates a real send failure (e.g. network error) for
    the listed chat ids, raising instead of recording — useful for exercising
    delivery-failure handling upstream.
    """

    def __init__(self, fail_for_chat_ids: Container[str] = ()) -> None:
        self.sent: list[tuple[str, str]] = []
        self._fail_for_chat_ids = fail_for_chat_ids

    async def send_message(self, chat_id: str, text: str) -> None:
        if chat_id in self._fail_for_chat_ids:
            raise RuntimeError(f"simulated delivery failure for chat_id={chat_id}")
        self.sent.append((chat_id, text))
