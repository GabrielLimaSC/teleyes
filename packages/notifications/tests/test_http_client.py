import json

import httpx
import pytest

from packages.notifications.http_client import HttpBotClient


async def test_send_message_posts_chat_id_and_text_to_send_message_endpoint() -> None:
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"ok": True})

    client = HttpBotClient("TEST:TOKEN", transport=httpx.MockTransport(handler))

    await client.send_message("123", "Promoção iPhone 15")

    assert captured["url"] == "https://api.telegram.org/botTEST:TOKEN/sendMessage"
    assert captured["body"] == {"chat_id": "123", "text": "Promoção iPhone 15"}


async def test_send_message_raises_on_http_error_response() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, json={"ok": False, "description": "chat not found"})

    client = HttpBotClient("TEST:TOKEN", transport=httpx.MockTransport(handler))

    with pytest.raises(httpx.HTTPStatusError):
        await client.send_message("999", "oi")
