import asyncio
import json
from collections.abc import AsyncGenerator
from typing import Protocol

from fastapi import APIRouter, Depends, Header, Request
from fastapi.responses import StreamingResponse

from app.main import get_current_session
from packages.events.broker import Event, EventBroker

router = APIRouter(tags=["events"])

KEEPALIVE_SECONDS = 15.0


class SupportsDisconnect(Protocol):
    """What `_stream` needs from a request — just enough to unit-test it with a fake."""

    async def is_disconnected(self) -> bool: ...


def _format_event(event: Event) -> str:
    payload = json.dumps(event.data, separators=(",", ":"))
    return f"id: {event.id}\nevent: {event.type}\ndata: {payload}\n\n"


def _format_resync() -> str:
    return "event: resync\ndata: {}\n\n"


async def _stream(
    request: SupportsDisconnect, broker: EventBroker, last_event_id: int | None
) -> AsyncGenerator[str, None]:
    subscription = broker.subscribe(last_event_id)
    try:
        if subscription.resync_required:
            yield _format_resync()
        for event in subscription.backlog:
            yield _format_event(event)

        while True:
            try:
                async with asyncio.timeout(KEEPALIVE_SECONDS):
                    next_event = await subscription.queue.get()
            except TimeoutError:
                if await request.is_disconnected():
                    return
                yield ": keepalive\n\n"
                continue

            if next_event is None:
                return
            yield _format_event(next_event)
    finally:
        broker.unsubscribe(subscription.id)


@router.get("/events", dependencies=[Depends(get_current_session)])
async def stream_events(
    request: Request,
    last_event_id: str | None = Header(default=None, alias="Last-Event-ID"),
) -> StreamingResponse:
    broker: EventBroker = request.app.state.event_broker
    parsed_last_event_id: int | None = None
    if last_event_id is not None:
        try:
            parsed_last_event_id = int(last_event_id)
        except ValueError:
            parsed_last_event_id = None

    return StreamingResponse(
        _stream(request, broker, parsed_last_event_id),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
