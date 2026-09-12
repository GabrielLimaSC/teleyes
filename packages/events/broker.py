from __future__ import annotations

import asyncio
from collections import deque
from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class Event:
    id: int
    type: str
    data: dict[str, Any]


@dataclass
class Subscription:
    """A live SSE subscriber: a queue to await new events plus the replay backlog.

    `resync_required` is set when the subscriber's `Last-Event-ID` is older than
    everything still in the broker's bounded history — the gap can't be replayed,
    so the caller must tell the client to reconsult REST instead.
    """

    id: int
    queue: asyncio.Queue[Event | None]
    backlog: list[Event] = field(default_factory=list)
    resync_required: bool = False


class EventBroker:
    """In-memory, bounded pub-sub broker for the SSE feed.

    Single-process by design (no Redis/Postgres queue) — matches teleyes staying
    one operable process. History is capped so memory never grows unbounded; a
    subscriber whose queue fills up (a slow/stuck client) is dropped rather than
    blocking `publish` for every other subscriber.
    """

    def __init__(self, history_size: int = 200, queue_size: int = 100) -> None:
        self._history: deque[Event] = deque(maxlen=history_size)
        self._subscribers: dict[int, asyncio.Queue[Event | None]] = {}
        self._queue_size = queue_size
        self._next_event_id = 0
        self._next_subscriber_id = 0

    def subscriber_count(self) -> int:
        return len(self._subscribers)

    def subscribe(self, last_event_id: int | None) -> Subscription:
        subscriber_id = self._next_subscriber_id
        self._next_subscriber_id += 1
        queue: asyncio.Queue[Event | None] = asyncio.Queue(maxsize=self._queue_size)

        backlog: list[Event] = []
        resync_required = False
        if last_event_id is not None and self._history:
            oldest_id = self._history[0].id
            if oldest_id > last_event_id + 1:
                resync_required = True
            else:
                backlog = [event for event in self._history if event.id > last_event_id]

        self._subscribers[subscriber_id] = queue
        return Subscription(
            id=subscriber_id, queue=queue, backlog=backlog, resync_required=resync_required
        )

    def unsubscribe(self, subscriber_id: int) -> None:
        self._subscribers.pop(subscriber_id, None)

    def publish(self, event_type: str, data: dict[str, Any]) -> Event:
        self._next_event_id += 1
        event = Event(id=self._next_event_id, type=event_type, data=data)
        self._history.append(event)

        stuck_subscribers: list[int] = []
        for subscriber_id, queue in self._subscribers.items():
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:
                stuck_subscribers.append(subscriber_id)

        for subscriber_id in stuck_subscribers:
            self._evict(subscriber_id)

        return event

    def _evict(self, subscriber_id: int) -> None:
        """Drop a subscriber whose queue is full instead of blocking publish.

        A `None` sentinel tells the SSE generator to close the connection; the
        client's EventSource reconnects and, via `Last-Event-ID`, either replays
        the backlog or gets `resync_required` and falls back to REST.
        """
        queue = self._subscribers.pop(subscriber_id, None)
        if queue is None:
            return
        while True:
            try:
                queue.put_nowait(None)
                return
            except asyncio.QueueFull:
                try:
                    queue.get_nowait()
                except asyncio.QueueEmpty:
                    return
