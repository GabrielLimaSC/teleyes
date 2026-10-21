"""S19-03: demo mode (`TELEYES_DEMO=1`) — the real app over fictional data.

A demo database is recognisable by its marker: every source and recipient has a
`telegram_chat_id` starting with `demo:` (not a shape any real Telegram id has),
and the single admin's password is the public `DEMO_PASSWORD`. The two modes
never mix: demo mode refuses a database holding anything else, and normal mode
refuses a database holding the marker, so the public demo password can only ever
exist next to fictional data.

Nothing here opens a network connection: `DemoNotifier` is a no-op.
"""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable, MutableMapping
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

from auth.hashing import verify_password
from models import Admin, Recipient, Rule, Source
from packages.notifications.bot import BotNotifier, DeliveryResult

DEMO_PASSWORD = "demo-teleyes"
DEMO_CHAT_PREFIX = "demo:"
READ_ONLY_MESSAGE = "Modo demonstração: alterações desativadas."
MUTATING_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})
# Login/logout only touch the session. `/rules/test` is a dry run that never
# writes (see its docstring), so it keeps working in the read-only demo.
READ_ONLY_EXEMPT_PATHS = frozenset({"/auth/login", "/auth/logout", "/rules/test"})


class DemoModeError(RuntimeError):
    """The database does not match the mode the app was started in."""


def is_demo_chat_id(chat_id: str) -> bool:
    return chat_id.startswith(DEMO_CHAT_PREFIX)


def check_database_mode(session: Session, *, demo: bool) -> None:
    """Refuse to start when the database belongs to the other mode.

    A database whose tables do not exist yet (migrations not run) passes: there
    is nothing to mix up.
    """
    try:
        chat_ids = [
            *session.scalars(select(Source.telegram_chat_id)),
            *session.scalars(select(Recipient.telegram_chat_id)),
        ]
        rule_count = session.scalar(select(func.count()).select_from(Rule)) or 0
        admin = session.scalar(select(Admin))
    except OperationalError:
        return

    marked = [chat_id for chat_id in chat_ids if is_demo_chat_id(chat_id)]
    if not demo:
        if marked:
            raise DemoModeError(
                "Este banco é de demonstração (fontes/destinatários 'demo:'). "
                "Inicie com TELEYES_DEMO=1 ou aponte para outro banco."
            )
        return

    if len(marked) != len(chat_ids):
        raise DemoModeError(
            "TELEYES_DEMO=1 recusa um banco com dados reais (fonte/destinatário sem "
            "o marcador 'demo:'). Use um banco novo ou o volume do docker-compose.demo.yml."
        )
    if not chat_ids and (rule_count or admin is not None):
        raise DemoModeError("TELEYES_DEMO=1 recusa um banco que não foi semeado como demonstração.")
    if admin is not None and not verify_password(DEMO_PASSWORD, admin.password_hash):
        raise DemoModeError(
            "TELEYES_DEMO=1 recusa um banco cujo administrador não é o da demonstração."
        )


class DemoNotifier(BotNotifier):
    """Reports every alert as sent without ever sending anything.

    It has no token and no client, so there is no code path that could open a
    connection; `notify_digest` and `notify_operational` are equally inert.
    """

    def __init__(self) -> None:
        super().__init__(bot_token=None, client=None)

    def is_configured(self) -> bool:
        return True

    def delivery_block_reason(self, chat_id: str) -> str | None:
        return None

    async def notify(
        self, match_id: int, recipient_id: int, chat_id: str, text: str
    ) -> DeliveryResult:
        return DeliveryResult(delivered=True)

    async def notify_digest(self, chat_id: str, text: str) -> DeliveryResult:
        return DeliveryResult(delivered=True)

    async def notify_operational(self, text: str) -> None:
        return None


Scope = MutableMapping[str, Any]
Receive = Callable[[], Awaitable[MutableMapping[str, Any]]]
Send = Callable[[MutableMapping[str, Any]], Awaitable[None]]


class DemoReadOnlyMiddleware:
    """Pure ASGI (not `BaseHTTPMiddleware`) so SSE streams are never wrapped.

    `is_active` is read on every request, so the switch follows the settings
    instead of being frozen at import time.
    """

    def __init__(
        self,
        app: Callable[[Scope, Receive, Send], Awaitable[None]],
        *,
        is_active: Callable[[], bool],
    ) -> None:
        self._app = app
        self._is_active = is_active

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if (
            scope["type"] == "http"
            and scope["method"] in MUTATING_METHODS
            and scope["path"].rstrip("/") not in READ_ONLY_EXEMPT_PATHS
            and self._is_active()
        ):
            body = json.dumps({"detail": READ_ONLY_MESSAGE}, ensure_ascii=False).encode()
            await send(
                {
                    "type": "http.response.start",
                    "status": 403,
                    "headers": [
                        (b"content-type", b"application/json"),
                        (b"content-length", str(len(body)).encode()),
                    ],
                }
            )
            await send({"type": "http.response.body", "body": body})
            return
        await self._app(scope, receive, send)
