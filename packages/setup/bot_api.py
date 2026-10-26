"""S19-02: the few Bot API calls the wizard needs (`getMe`, `getUpdates`).

The only host this module talks to is `api.telegram.org`, and the token is checked
against a strict pattern before it is ever placed in a URL, so a hostile value cannot
steer the request elsewhere (no SSRF) or smuggle path segments.

Errors are reduced to a closed set of codes. `httpx` exceptions carry the request URL,
and the URL carries the token, so they are never chained, logged or re-raised.
"""

from __future__ import annotations

import hmac
import logging
import re
from dataclasses import dataclass
from enum import StrEnum
from typing import Any, Protocol

import httpx

logger = logging.getLogger(__name__)

BOT_API_HOST = "https://api.telegram.org"
TOKEN_PATTERN = re.compile(r"^\d{5,16}:[A-Za-z0-9_-]{30,64}$")
REQUEST_TIMEOUT_SECONDS = 15.0
MAX_POLL_SECONDS = 10

# `httpx` logs every request line at INFO, and the request line contains the token.
# Keep that out of any handler, whatever the root logger is configured to.
_TOKEN_IN_URL = re.compile(r"/bot\d+:[A-Za-z0-9_-]+")


class _RedactTokenFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        message = record.getMessage()
        if "/bot" in message:
            record.msg = _TOKEN_IN_URL.sub("/bot<redacted>", message)
            record.args = None
        return True


def silence_http_client_logging() -> None:
    for name in ("httpx", "httpcore"):
        target = logging.getLogger(name)
        target.setLevel(logging.WARNING)
        if not any(isinstance(f, _RedactTokenFilter) for f in target.filters):
            target.addFilter(_RedactTokenFilter())


silence_http_client_logging()


class BotApiErrorCode(StrEnum):
    TOKEN_INVALID = "token_invalid"
    NETWORK = "network"
    CONFLICT = "conflict"  # a webhook, or another getUpdates consumer, owns the updates
    UNEXPECTED = "unexpected"


class BotApiError(Exception):
    def __init__(self, code: BotApiErrorCode) -> None:
        super().__init__(code.value)
        self.code = code


@dataclass(frozen=True)
class BotIdentity:
    id: int
    username: str
    name: str


@dataclass(frozen=True)
class StartMessage:
    """A private `/start [payload]` message addressed to the bot."""

    update_id: int
    chat_id: str
    sender_name: str
    payload: str


@dataclass(frozen=True)
class UpdatesResult:
    next_offset: int | None
    starts: list[StartMessage]


class BotApi(Protocol):
    async def get_me(self) -> BotIdentity: ...

    async def get_start_messages(
        self, offset: int | None, timeout_seconds: int
    ) -> UpdatesResult: ...


def is_valid_token(token: str) -> bool:
    return bool(TOKEN_PATTERN.fullmatch(token or ""))


def codes_match(expected: str, given: str) -> bool:
    return hmac.compare_digest(expected.encode(), given.encode())


class HttpBotApi:
    def __init__(self, token: str, *, transport: httpx.AsyncBaseTransport | None = None) -> None:
        if not is_valid_token(token):
            raise BotApiError(BotApiErrorCode.TOKEN_INVALID)
        self._base_url = f"{BOT_API_HOST}/bot{token}"
        self._transport = transport

    async def _call(self, method: str, payload: dict[str, Any], timeout: float) -> Any:
        try:
            async with httpx.AsyncClient(timeout=timeout, transport=self._transport) as client:
                response = await client.post(f"{self._base_url}/{method}", json=payload)
        except httpx.HTTPError:
            raise BotApiError(BotApiErrorCode.NETWORK) from None
        if response.status_code in (401, 404):
            raise BotApiError(BotApiErrorCode.TOKEN_INVALID)
        if response.status_code == 409:
            raise BotApiError(BotApiErrorCode.CONFLICT)
        if response.status_code != 200:
            raise BotApiError(BotApiErrorCode.UNEXPECTED)
        try:
            body = response.json()
        except ValueError:
            raise BotApiError(BotApiErrorCode.UNEXPECTED) from None
        if not isinstance(body, dict) or body.get("ok") is not True:
            raise BotApiError(BotApiErrorCode.UNEXPECTED)
        return body.get("result")

    async def get_me(self) -> BotIdentity:
        result = await self._call("getMe", {}, REQUEST_TIMEOUT_SECONDS)
        if not isinstance(result, dict) or not result.get("username") or not result.get("is_bot"):
            raise BotApiError(BotApiErrorCode.UNEXPECTED)
        return BotIdentity(
            id=int(result["id"]),
            username=str(result["username"]),
            name=str(result.get("first_name", "")),
        )

    async def get_start_messages(self, offset: int | None, timeout_seconds: int) -> UpdatesResult:
        timeout = max(0, min(timeout_seconds, MAX_POLL_SECONDS))
        payload: dict[str, Any] = {"timeout": timeout, "allowed_updates": ["message"]}
        if offset is not None:
            payload["offset"] = offset
        result = await self._call("getUpdates", payload, timeout + REQUEST_TIMEOUT_SECONDS)
        if not isinstance(result, list):
            raise BotApiError(BotApiErrorCode.UNEXPECTED)
        starts: list[StartMessage] = []
        highest: int | None = None
        for update in result:
            if not isinstance(update, dict) or not isinstance(update.get("update_id"), int):
                continue
            update_id: int = update["update_id"]
            highest = update_id if highest is None else max(highest, update_id)
            start = _as_start(update_id, update.get("message"))
            if start is not None:
                starts.append(start)
        return UpdatesResult(next_offset=None if highest is None else highest + 1, starts=starts)


def _as_start(update_id: int, message: object) -> StartMessage | None:
    if not isinstance(message, dict):
        return None
    chat = message.get("chat")
    text = message.get("text")
    if not isinstance(chat, dict) or chat.get("type") != "private" or not isinstance(text, str):
        return None
    if not isinstance(chat.get("id"), int):
        return None
    head, _, payload = text.strip().partition(" ")
    command = head.split("@", 1)[0]
    if command != "/start":
        return None
    sender = message.get("from")
    name = ""
    if isinstance(sender, dict):
        name = str(sender.get("first_name") or sender.get("username") or "")
    return StartMessage(
        update_id=update_id,
        chat_id=str(chat["id"]),
        sender_name=name[:80],
        payload=payload.strip(),
    )
