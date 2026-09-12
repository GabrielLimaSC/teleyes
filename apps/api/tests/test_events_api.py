import asyncio
import json
from collections.abc import AsyncGenerator
from dataclasses import dataclass
from types import SimpleNamespace

import pytest
from fastapi.responses import StreamingResponse
from fastapi.testclient import TestClient

from app.main import app
from app.routers import events as events_module
from app.routers.events import _stream, stream_events
from packages.events.broker import EventBroker

PASSWORD = "correct horse battery staple"


@dataclass
class FakeRequest:
    """Just enough of `Request` for `_stream`/`stream_events`: disconnect check + app.state."""

    broker: EventBroker
    disconnected: bool = False

    def __post_init__(self) -> None:
        self.app = SimpleNamespace(state=SimpleNamespace(event_broker=self.broker))

    async def is_disconnected(self) -> bool:
        return self.disconnected


async def _next_chunk(gen: AsyncGenerator[str, None]) -> str:
    return await asyncio.wait_for(gen.__anext__(), timeout=1)


def test_events_endpoint_rejects_anonymous_access() -> None:
    with TestClient(app, base_url="https://testserver") as client:
        response = client.get("/events")

    assert response.status_code == 401


async def test_stream_delivers_a_published_event_live() -> None:
    broker = EventBroker()
    gen = _stream(FakeRequest(broker), broker, last_event_id=None)

    task: asyncio.Task[str] = asyncio.create_task(gen.__anext__())
    await asyncio.sleep(0)  # let the generator reach broker.subscribe() and block on the queue
    broker.publish("match", {"match_id": 1, "deliveries_sent": 1})

    chunk = await asyncio.wait_for(task, timeout=1)

    lines = chunk.strip("\n").split("\n")
    assert lines[0] == "id: 1"
    assert lines[1] == "event: match"
    assert json.loads(lines[2].removeprefix("data:").strip()) == {
        "match_id": 1,
        "deliveries_sent": 1,
    }
    await gen.aclose()


async def test_reconnect_with_last_event_id_replays_the_missed_event() -> None:
    broker = EventBroker()
    first = broker.publish("match", {"match_id": 1})
    second = broker.publish("match", {"match_id": 2})

    gen = _stream(FakeRequest(broker), broker, last_event_id=first.id)

    chunk = await _next_chunk(gen)

    assert chunk.startswith(f"id: {second.id}\n")
    assert json.loads(chunk.split("\n")[2].removeprefix("data:").strip()) == {"match_id": 2}
    await gen.aclose()


async def test_reconnect_past_evicted_history_asks_the_client_to_resync() -> None:
    broker = EventBroker(history_size=2)
    # 4 events through a 2-slot history: ids 1 and 2 are evicted, leaving a real gap
    # before whatever the client already saw (id 1).
    first = broker.publish("match", {"match_id": 1})
    broker.publish("match", {"match_id": 2})
    broker.publish("match", {"match_id": 3})
    broker.publish("match", {"match_id": 4})

    gen = _stream(FakeRequest(broker), broker, last_event_id=first.id)

    chunk = await _next_chunk(gen)

    assert chunk == "event: resync\ndata: {}\n\n"
    await gen.aclose()


async def test_evicted_subscriber_closes_the_stream_without_error() -> None:
    broker = EventBroker(queue_size=1)
    gen = _stream(FakeRequest(broker), broker, last_event_id=None)

    task: asyncio.Task[str] = asyncio.create_task(gen.__anext__())
    await asyncio.sleep(0)  # let the generator subscribe and block on the (still empty) queue
    broker.publish("match", {"match_id": 1})
    # Second publish overflows the 1-slot queue before the subscriber ever got to run
    # and drain the first item, so eviction discards it in favor of the close sentinel.
    broker.publish("match", {"match_id": 2})

    with pytest.raises(StopAsyncIteration):
        await asyncio.wait_for(task, timeout=1)
    assert broker.subscriber_count() == 0


async def test_unsubscribes_when_the_client_disconnects_on_keepalive_check(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(events_module, "KEEPALIVE_SECONDS", 0.01)
    broker = EventBroker()
    request = FakeRequest(broker, disconnected=True)
    gen = _stream(request, broker, last_event_id=None)

    with pytest.raises(StopAsyncIteration):
        await asyncio.wait_for(gen.__anext__(), timeout=1)

    assert broker.subscriber_count() == 0


async def test_stream_events_wires_last_event_id_and_broker_from_app_state() -> None:
    broker = EventBroker()
    broker.publish("match", {"match_id": 1})
    request = FakeRequest(broker)

    response = await stream_events(request=request, last_event_id="1")  # type: ignore[arg-type]

    assert isinstance(response, StreamingResponse)
    assert response.media_type == "text/event-stream"
