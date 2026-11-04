import json

import httpx
import pytest

from teleyes_core.notifications.http_client import BotSendError, HttpBotClient


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

    with pytest.raises(BotSendError) as raised:
        await client.send_message("999", "oi")

    assert raised.value.status_code == 400
    assert "TOKEN" not in str(raised.value)
    assert raised.value.__cause__ is None and raised.value.__suppress_context__


async def test_a_network_failure_does_not_leak_the_token() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("boom", request=request)

    client = HttpBotClient("TEST:TOKEN", transport=httpx.MockTransport(handler))

    with pytest.raises(BotSendError) as raised:
        await client.send_message("999", "oi")

    assert raised.value.status_code is None
    assert "TOKEN" not in str(raised.value)


async def test_a_hostile_token_cannot_change_the_host_or_the_path() -> None:
    seen: list[httpx.URL] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.url)
        return httpx.Response(200, json={"ok": True})

    hostile = "1:x@evil.example/../../?"
    client = HttpBotClient(hostile, transport=httpx.MockTransport(handler))

    await client.send_message("1", "oi")

    assert seen[0].host == "api.telegram.org"
    assert seen[0].path.endswith("/sendMessage")
    assert seen[0].query == b""
    assert seen[0].raw_path.count(b"/") == 2  # "/bot<token>/sendMessage", no extra segments

