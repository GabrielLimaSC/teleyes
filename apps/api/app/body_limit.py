"""S23-01: a hard ceiling on request bodies.

Every JSON body the api accepts is a few hundred bytes (a rule, a source, a price). The
largest legitimate one is a rule's term lists. Nothing uploads files. Rejecting anything
bigger than `MAX_BODY_BYTES` stops a megabyte-sized "rule name" from being parsed,
stored and echoed back, whether or not the client declares a Content-Length.

Pure ASGI (not `BaseHTTPMiddleware`), like `DemoReadOnlyMiddleware`, so SSE streams are
never wrapped.
"""

import json
from collections.abc import Awaitable, Callable, MutableMapping
from typing import Any

Scope = MutableMapping[str, Any]
Message = MutableMapping[str, Any]
Receive = Callable[[], Awaitable[Message]]
Send = Callable[[Message], Awaitable[None]]

MAX_BODY_BYTES = 256 * 1024
TOO_LARGE_MESSAGE = "Requisição grande demais."


class _TooLarge(Exception):
    pass


class BodySizeLimitMiddleware:
    def __init__(
        self,
        app: Callable[[Scope, Receive, Send], Awaitable[None]],
        *,
        max_bytes: int = MAX_BODY_BYTES,
    ) -> None:
        self._app = app
        self._max_bytes = max_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self._app(scope, receive, send)
            return

        declared = dict(scope["headers"]).get(b"content-length")
        if declared is not None and declared.isdigit() and int(declared) > self._max_bytes:
            await self._reject(send)
            return

        received = 0
        exceeded = False
        replaced = False

        async def limited_receive() -> Message:
            nonlocal received, exceeded
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > self._max_bytes:
                    exceeded = True
                    raise _TooLarge
            return message

        async def guarded_send(message: Message) -> None:
            # FastAPI turns an error raised while it reads the body into its own 400;
            # whatever the app answers after the limit was crossed becomes the 413.
            nonlocal replaced
            if not exceeded:
                await send(message)
            elif not replaced:
                replaced = True
                await self._reject(send)

        try:
            await self._app(scope, limited_receive, guarded_send)
        except _TooLarge:
            if not replaced:
                await self._reject(send)

    @staticmethod
    async def _reject(send: Send) -> None:
        body = json.dumps({"detail": TOO_LARGE_MESSAGE}, ensure_ascii=False).encode()
        await send(
            {
                "type": "http.response.start",
                "status": 413,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"content-length", str(len(body)).encode()),
                    (b"connection", b"close"),
                ],
            }
        )
        await send({"type": "http.response.body", "body": body})
