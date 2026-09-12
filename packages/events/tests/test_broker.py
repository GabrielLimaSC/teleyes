import asyncio

from packages.events.broker import EventBroker


async def test_subscriber_receives_events_published_after_subscribing() -> None:
    broker = EventBroker()
    subscription = broker.subscribe(last_event_id=None)

    broker.publish("match", {"match_id": 1})

    event = await asyncio.wait_for(subscription.queue.get(), timeout=1)
    assert event is not None
    assert event.type == "match"
    assert event.data == {"match_id": 1}
    assert subscription.backlog == []
    assert subscription.resync_required is False


async def test_reconnect_with_last_event_id_replays_missed_events() -> None:
    broker = EventBroker()
    first = broker.publish("match", {"match_id": 1})
    second = broker.publish("match", {"match_id": 2})

    subscription = broker.subscribe(last_event_id=first.id)

    assert [event.id for event in subscription.backlog] == [second.id]
    assert subscription.resync_required is False


async def test_reconnect_past_evicted_history_requires_resync() -> None:
    # 4 events through a 2-slot history: ids 1 and 2 are evicted, leaving a real gap
    # after last_event_id=1 (id 2 — the event right after it — is gone too).
    broker = EventBroker(history_size=2)
    broker.publish("match", {"match_id": 1})
    broker.publish("match", {"match_id": 2})
    broker.publish("match", {"match_id": 3})
    broker.publish("match", {"match_id": 4})

    subscription = broker.subscribe(last_event_id=1)

    assert subscription.resync_required is True
    assert subscription.backlog == []


async def test_unsubscribed_subscriber_stops_receiving_events() -> None:
    broker = EventBroker()
    subscription = broker.subscribe(last_event_id=None)
    broker.unsubscribe(subscription.id)

    broker.publish("match", {"match_id": 1})

    assert subscription.queue.empty()


async def test_full_queue_evicts_the_slow_subscriber_with_a_close_sentinel() -> None:
    broker = EventBroker(queue_size=2)
    subscription = broker.subscribe(last_event_id=None)

    broker.publish("match", {"match_id": 1})
    broker.publish("match", {"match_id": 2})
    broker.publish("match", {"match_id": 3})

    received = []
    while not subscription.queue.empty():
        received.append(subscription.queue.get_nowait())

    assert received[-1] is None
    broker.publish("match", {"match_id": 4})
    assert subscription.queue.empty()
