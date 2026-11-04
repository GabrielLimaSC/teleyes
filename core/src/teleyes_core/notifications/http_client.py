from urllib.parse import quote

import httpx

BOT_API_HOST = "https://api.telegram.org"


class BotSendError(Exception):
    """A `sendMessage` call failed.

    Carries only the HTTP status (or None for a network failure). `httpx` exceptions
    embed the request URL, and the URL embeds the bot token, so they are never chained
    or re-raised: a traceback in a log must not be a token leak (S23-01).
    """

    def __init__(self, status_code: int | None = None) -> None:
        super().__init__(
            f"bot sendMessage failed (HTTP {status_code})"
            if status_code is not None
            else "bot sendMessage failed (network error)"
        )
        self.status_code = status_code


class HttpBotClient:
    """Real Telegram Bot API client using the HTTP `sendMessage` endpoint.

    The only host it talks to is `api.telegram.org`. The token is percent-encoded
    before it goes into the URL, so a hostile value cannot add path segments, a query
    or another host (no SSRF), and redirects are never followed.
    """

    def __init__(
        self, bot_token: str, *, transport: httpx.AsyncBaseTransport | None = None
    ) -> None:
        self._base_url = f"{BOT_API_HOST}/bot{quote(bot_token, safe=':')}"
        self._transport = transport

    async def send_message(self, chat_id: str, text: str) -> None:
        try:
            async with httpx.AsyncClient(
                timeout=10.0, transport=self._transport, follow_redirects=False
            ) as client:
                response = await client.post(
                    f"{self._base_url}/sendMessage", json={"chat_id": chat_id, "text": text}
                )
                response.raise_for_status()
        except httpx.HTTPStatusError as error:
            raise BotSendError(error.response.status_code) from None
        except httpx.HTTPError:
            raise BotSendError() from None
