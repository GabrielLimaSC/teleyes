"""S19-02 e2e backend: the REAL api with a FAKE Telegram and a FAKE bot.

Only the three edges that would talk to the network are replaced (Telethon login, the Bot
API client, the bot notifier). Everything else is the production code: routers, rate
limits, the secret store, the session file, CSRF, the database. A few `/__e2e/*` helpers
let the test play the parts of the outside world (the person tapping Start in Telegram,
a Telegram flood wait) and wipe the state between tests.

NEVER used outside the e2e run: it is not imported by the app and not shipped in the image.
"""

from __future__ import annotations

import asyncio
import contextlib
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from typing import Any

from fastapi import FastAPI
from pydantic import BaseModel
from sqlalchemy import delete
from tests.setup_support import (
    CODE,
    FakeTelegramWorld,
    flood_wait,
    start_message,
)

from app.config import get_settings
from app.dialog_scan import DialogScanWorker
from app.listener_control import touch_listener_seen
from app.main import app
from app.setup_runtime import build_limiters, session_path
from models import (
    DialogScan,
    ListenerControl,
    Recipient,
    Rule,
    SecurityEvent,
    Source,
    TelegramDialog,
)
from packages.notifications.bot import BotNotifier
from packages.notifications.fakes import FakeBotClient
from packages.setup.bot_api import BotApiError, BotApiErrorCode, BotIdentity, UpdatesResult
from packages.setup.credentials import remove_session_files
from packages.setup.telegram_login import TelegramLoginService

WORLD = FakeTelegramWorld()
INBOX: list[Any] = []
BOT_USERNAME = "teleyes_e2e_bot"


class E2EBotApi:
    def __init__(self, token: str) -> None:
        self._token = token

    def _check(self) -> None:
        if "INVALID" in self._token:
            raise BotApiError(BotApiErrorCode.TOKEN_INVALID)

    async def get_me(self) -> BotIdentity:
        self._check()
        return BotIdentity(id=1, username=BOT_USERNAME, name="Teleyes E2E")

    async def get_start_messages(self, offset: int | None, timeout_seconds: int) -> UpdatesResult:
        self._check()
        await asyncio.sleep(0.4)  # a short long-poll
        starts, INBOX[:] = list(INBOX), []
        highest = max((s.update_id for s in starts), default=None)
        return UpdatesResult(next_offset=None if highest is None else highest + 1, starts=starts)


class FakeDialog:
    def __init__(self, chat_id: int, name: str, *, group: bool, channel: bool, user: bool) -> None:
        self.id, self.name = chat_id, name
        self.is_group, self.is_channel, self.is_user = group, channel, user


class FakeDialogClient:
    async def iter_dialogs(self) -> AsyncIterator[FakeDialog]:
        for dialog in [
            FakeDialog(-1001, "Promoções de Hardware", group=True, channel=True, user=False),
            FakeDialog(-1002, "Ofertas Gamer (canal)", group=False, channel=True, user=False),
            FakeDialog(-1003, "Black Friday BR", group=True, channel=False, user=False),
            FakeDialog(77, "Maria (conversa privada)", group=False, channel=False, user=True),
        ]:
            yield dialog


SENT = FakeBotClient()
app.state.bot_api_factory = E2EBotApi
app.state.bot_notifier_factory = lambda ids: BotNotifier(
    bot_token="e2e", client=SENT, allowlisted_chat_ids=ids
)
app.state.telegram_login = TelegramLoginService(
    session_path=session_path(get_settings()), client_factory=WORLD.factory
)


@asynccontextmanager
async def _with_fake_listener(application: FastAPI) -> AsyncIterator[None]:
    """The role of the listener process: a heartbeat, and answering the group scan."""
    worker = DialogScanWorker(
        session_factory=application.state.session_factory,
        client=FakeDialogClient(),
        is_connected=lambda: True,
    )

    async def run() -> None:
        while True:
            with application.state.session_factory() as session:
                touch_listener_seen(session, now=datetime.now(UTC))
            with contextlib.suppress(Exception):
                await worker.poll_once()
            await asyncio.sleep(0.5)

    task = asyncio.create_task(run())
    try:
        yield
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


_original_lifespan = app.router.lifespan_context


@asynccontextmanager
async def _lifespan(application: FastAPI) -> AsyncIterator[None]:
    async with _original_lifespan(application), _with_fake_listener(application):
        yield


app.router.lifespan_context = _lifespan


class StartBody(BaseModel):
    code: str
    chat_id: str = "5550001"
    name: str = "Gabriel E2E"


class FloodBody(BaseModel):
    seconds: int


@app.post("/__e2e/start")
def e2e_start(body: StartBody) -> dict[str, str]:
    """The person taps Start in Telegram on the pairing link."""
    INBOX.append(start_message(len(INBOX) + 1, body.chat_id, body.code, body.name))
    return {"status": "queued"}


@app.post("/__e2e/flood")
def e2e_flood(body: FloodBody) -> dict[str, int]:
    """The next code request is refused by Telegram with a flood wait."""
    WORLD.send_error = flood_wait(body.seconds)
    return {"seconds": body.seconds}


@app.post("/__e2e/two-factor")
def e2e_two_factor() -> dict[str, str]:
    WORLD.password = "e2e-2fa-password"
    return {"password": "set"}


@app.post("/__e2e/reset")
async def e2e_reset() -> dict[str, str]:
    """Back to a fresh install: no credentials, session, bot, recipient, group or rule."""
    await app.state.telegram_login.cancel()
    remove_session_files(session_path(get_settings()))
    app.state.secret_store.clear_secrets()
    app.state.setup_limiters = build_limiters()
    app.state.bot_pairing = None
    INBOX.clear()
    SENT.sent.clear()
    WORLD.send_error = None
    WORLD.password = None
    WORLD.code_error = None
    WORLD.code = CODE
    with app.state.session_factory() as session:
        for model in (Recipient, Source, Rule, TelegramDialog, DialogScan, SecurityEvent):
            session.execute(delete(model))
        control = session.get(ListenerControl, 1)
        if control is not None:
            session.delete(control)
        session.commit()
    return {"status": "reset"}


@app.get("/__e2e/sent")
def e2e_sent() -> list[list[str]]:
    return [[chat, text] for chat, text in SENT.sent]

