"""Fakes for the S19-02 setup wizard tests: a scripted Telegram account and bot.

Nothing here opens a socket. The Telethon errors raised are the real classes, so the
service's error mapping is exercised exactly as it would be against Telegram.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from telethon import errors

from packages.setup.bot_api import (
    BotApiError,
    BotApiErrorCode,
    BotIdentity,
    StartMessage,
    UpdatesResult,
)

# Sentinels: the tests assert these never leak into a response, a log or an event.
API_ID = 424242
API_HASH = "0123456789abcdef0123456789abcdef"
PHONE = "+5511987654321"
CODE = "13579"
PASSWORD = "correct-horse-2fa-secret"
BOT_TOKEN = "123456789:AAFakeTokenFakeTokenFakeTokenFake_x1"
BOT_USERNAME = "teleyes_test_bot"


@dataclass
class FakeTelegramWorld:
    """What the 'Telegram servers' will do; mutate before driving the flow."""

    code: str = CODE
    password: str | None = None  # None: the account has no 2FA
    send_error: BaseException | None = None
    connect_error: BaseException | None = None
    code_error: BaseException | None = None
    clients: list[FakeLoginClient] = field(default_factory=list)

    def factory(self, session_path: Path, api_id: int, api_hash: str) -> FakeLoginClient:
        client = FakeLoginClient(self, session_path, api_id, api_hash)
        self.clients.append(client)
        return client

    @property
    def open_clients(self) -> int:
        return sum(1 for client in self.clients if client.connected)


class FakeLoginClient:
    def __init__(
        self, world: FakeTelegramWorld, session_path: Path, api_id: int, api_hash: str
    ) -> None:
        self.world = world
        self.session_path = session_path
        self.api_id = api_id
        self.api_hash = api_hash
        self.connected = False
        self.signed_in = False
        self.disconnects = 0

    async def connect(self) -> None:
        if self.world.connect_error is not None:
            raise self.world.connect_error
        self.connected = True
        # Telethon creates its SQLite session file as soon as it connects.
        self.session_path.parent.mkdir(parents=True, exist_ok=True)
        self.session_path.write_bytes(b"fake-session-bytes")

    async def disconnect(self) -> None:
        self.connected = False
        self.disconnects += 1

    async def send_code_request(self, phone: str) -> Any:
        if self.world.send_error is not None:
            raise self.world.send_error
        return SimpleNamespace(phone_code_hash="HASH-OF-THE-CODE")

    async def sign_in(
        self,
        phone: str | None = None,
        code: str | None = None,
        *,
        password: str | None = None,
        phone_code_hash: str | None = None,
    ) -> Any:
        if password is not None:
            if password != self.world.password:
                raise errors.PasswordHashInvalidError(request=None)
            self.signed_in = True
            return SimpleNamespace(id=1)
        if self.world.code_error is not None:
            raise self.world.code_error
        if code != self.world.code:
            raise errors.PhoneCodeInvalidError(request=None)
        if self.world.password is not None:
            raise errors.SessionPasswordNeededError(request=None)
        self.signed_in = True
        return SimpleNamespace(id=1)


def flood_wait(seconds: int) -> errors.FloodWaitError:
    return errors.FloodWaitError(request=None, capture=seconds)


class FakeClock:
    def __init__(self, start: float = 1000.0) -> None:
        self.now = start

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


@dataclass
class FakeBot:
    """A scripted Bot API: `identity`/`token_ok` for getMe, `inbox` for getUpdates."""

    token_ok: bool = True
    network_down: bool = False
    conflict: bool = False
    identity: BotIdentity = field(
        default_factory=lambda: BotIdentity(id=777, username=BOT_USERNAME, name="Teleyes")
    )
    inbox: list[StartMessage] = field(default_factory=list)
    tokens_seen: list[str] = field(default_factory=list)
    get_updates_calls: int = 0

    def factory(self, token: str) -> FakeBotApi:
        self.tokens_seen.append(token)
        return FakeBotApi(self)


class FakeBotApi:
    def __init__(self, bot: FakeBot) -> None:
        self._bot = bot

    def _check(self) -> None:
        if self._bot.network_down:
            raise BotApiError(BotApiErrorCode.NETWORK)
        if not self._bot.token_ok:
            raise BotApiError(BotApiErrorCode.TOKEN_INVALID)

    async def get_me(self) -> BotIdentity:
        self._check()
        return self._bot.identity

    async def get_start_messages(self, offset: int | None, timeout_seconds: int) -> UpdatesResult:
        self._check()
        if self._bot.conflict:
            raise BotApiError(BotApiErrorCode.CONFLICT)
        self._bot.get_updates_calls += 1
        starts, self._bot.inbox = self._bot.inbox, []
        highest = max((s.update_id for s in starts), default=None)
        return UpdatesResult(next_offset=None if highest is None else highest + 1, starts=starts)


def start_message(
    update_id: int, chat_id: str, payload: str, name: str = "Gabriel"
) -> StartMessage:
    return StartMessage(update_id=update_id, chat_id=chat_id, sender_name=name, payload=payload)
