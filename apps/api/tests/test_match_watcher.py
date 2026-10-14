"""S17-03: the api turns matches written by ANOTHER connection (the listener
process) into `match` SSE events, without re-emitting history or the same id.

Real parts: a SQLite file in WAL mode, two independent engines (the "listener"
writes with one, the api watcher reads with the other), the real `EventBroker`
and the real SSE `_stream`.
"""

import asyncio
import json
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy.orm import Session, sessionmaker

import app.main  # noqa: F401  (registers routers first, avoiding a circular import)
from app.match_watcher import MatchWatcher, watch_matches
from app.routers.events import _stream
from models import Delivery, Match, Recipient, Rule, Source
from models.db import get_engine, get_sessionmaker
from packages.events.broker import EventBroker

NOW = datetime(2026, 10, 14, 12, 0, tzinfo=UTC)


class _Request:
    async def is_disconnected(self) -> bool:
        return False


def _listener_factory(db_path: Path) -> sessionmaker[Session]:
    return get_sessionmaker(get_engine(f"sqlite:///{db_path}"))


def _seed_base(session: Session) -> tuple[int, int, int]:
    source = Source(name="Grupo", telegram_chat_id="-100")
    rule = Rule(name="GPU", include_terms="rtx")
    recipient = Recipient(name="Gabriel", telegram_chat_id="1")
    session.add_all([source, rule, recipient])
    session.commit()
    return source.id, rule.id, recipient.id


def _insert_match(
    factory: sessionmaker[Session],
    ids: tuple[int, int, int],
    message_id: int,
    delivery_status: str | None,
) -> int:
    source_id, rule_id, recipient_id = ids
    with factory() as listener_session:
        match = Match(
            source_id=source_id,
            rule_id=rule_id,
            message_text="RTX 5070 por R$ 3.000,00",
            price_cents=300000,
            product_key="rtx-5070",
            matched_at=NOW,
            telegram_message_id=message_id,
        )
        listener_session.add(match)
        listener_session.flush()
        if delivery_status is not None:
            listener_session.add(
                Delivery(match_id=match.id, recipient_id=recipient_id, status=delivery_status)
            )
        listener_session.commit()
        return match.id


async def test_match_from_another_connection_reaches_the_sse_stream(
    db_path: Path, session: Session
) -> None:
    ids = _seed_base(session)
    listener = _listener_factory(db_path)
    api_factory = _listener_factory(db_path)
    broker = EventBroker()
    gen = _stream(_Request(), broker, last_event_id=None)

    async with watch_matches(api_factory, broker, interval=0.05):
        task: asyncio.Task[str] = asyncio.create_task(gen.__anext__())
        await asyncio.sleep(0.2)  # boot baseline taken, stream subscribed
        match_id = await asyncio.to_thread(_insert_match, listener, ids, 1, "sent")
        chunk = await asyncio.wait_for(task, timeout=3)

    lines = chunk.strip("\n").split("\n")
    assert lines[1] == "event: match"
    payload = json.loads(lines[2].removeprefix("data:").strip())
    assert payload["match_id"] == match_id
    assert payload["deliveries_sent"] == 1
    assert payload["group_key"] is not None
    await gen.aclose()


async def test_history_before_boot_is_not_emitted(db_path: Path, session: Session) -> None:
    ids = _seed_base(session)
    listener = _listener_factory(db_path)
    _insert_match(listener, ids, 1, "sent")
    broker = EventBroker()
    watcher = MatchWatcher(_listener_factory(db_path), broker)

    assert await watcher.poll_once() == 0  # baseline only
    assert await watcher.poll_once() == 0
    assert broker.publish("probe", {}).id == 1  # nothing was published before


async def test_same_id_is_never_published_twice(db_path: Path, session: Session) -> None:
    ids = _seed_base(session)
    listener = _listener_factory(db_path)
    broker = EventBroker()
    watcher = MatchWatcher(_listener_factory(db_path), broker)
    await watcher.poll_once()

    _insert_match(listener, ids, 1, "sent")
    assert await watcher.poll_once() == 1
    assert await watcher.poll_once() == 0
    _insert_match(listener, ids, 2, "sent")
    assert await watcher.poll_once() == 1


async def test_historical_scan_matches_are_not_published_but_cursor_moves(
    db_path: Path, session: Session
) -> None:
    ids = _seed_base(session)
    listener = _listener_factory(db_path)
    broker = EventBroker()
    watcher = MatchWatcher(_listener_factory(db_path), broker)
    await watcher.poll_once()

    _insert_match(listener, ids, 1, "historical")
    _insert_match(listener, ids, 2, "historical")
    live_id = _insert_match(listener, ids, 3, "sent")

    assert await watcher.poll_once() == 1
    assert broker.subscribe(0).backlog[0].data["match_id"] == live_id
    assert await watcher.poll_once() == 0


async def test_loop_survives_a_failing_tick(db_path: Path, session: Session) -> None:
    ids = _seed_base(session)
    listener = _listener_factory(db_path)
    broker = EventBroker()
    calls = {"n": 0}
    real_factory = _listener_factory(db_path)

    def flaky() -> Session:
        calls["n"] += 1
        if calls["n"] == 2:
            raise RuntimeError("boom")
        return real_factory()

    async with watch_matches(flaky, broker, interval=0.02):
        await asyncio.sleep(0.15)
        _insert_match(listener, ids, 1, "sent")
        await asyncio.sleep(0.3)

    assert [e.data["match_id"] for e in broker.subscribe(0).backlog] == [1]
