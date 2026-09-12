import httpx


class HttpBotClient:
    """Real Telegram Bot API client using the HTTP `sendMessage` endpoint."""

    def __init__(
        self, bot_token: str, *, transport: httpx.AsyncBaseTransport | None = None
    ) -> None:
        self._base_url = f"https://api.telegram.org/bot{bot_token}"
        self._transport = transport

    async def send_message(self, chat_id: str, text: str) -> None:
        async with httpx.AsyncClient(timeout=10.0, transport=self._transport) as client:
            response = await client.post(
                f"{self._base_url}/sendMessage", json={"chat_id": chat_id, "text": text}
            )
            response.raise_for_status()
