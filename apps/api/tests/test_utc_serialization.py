"""S13-01: every datetime leaves the API as UTC with an explicit `Z`.

SQLite returns naive datetimes, and a naive ISO string is read by a browser as
*local* time — the real symptom was every time shown 3h early in America/Sao_Paulo.
"""

import ast
import itertools
import json
import re
import time
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.main import app
from app.pipeline import ProcessResult, build_match_event, publish_match_event
from app.routers.events import _format_event
from app.utc import ensure_utc, format_utc
from auth.hashing import hash_password
from auth.rate_limit import LoginRateLimiter
from auth.session import SessionStore
from models import Admin, Delivery, Match, Recipient, Rule, Source
from models.base import Base
from packages.events.broker import EventBroker
from packages.metrics.counters import MetricReason, increment_counter
from packages.telegram.adapter import TelegramAdapter
from packages.telegram.fakes import FakeTelegramClient

PASSWORD = "correct horse battery staple"

# 22:43 in Brasília (UTC-3) on 2026-09-19 is 01:43 UTC on 2026-09-20 — the exact
# instant from the real-screen report.
MATCH_INSTANT = datetime(2026, 9, 20, 1, 43, 0, tzinfo=UTC)
MATCH_ISO = "2026-09-20T01:43:00Z"
UTC_DATETIME = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$")


@dataclass
class ApiContext:
    client: TestClient
    session_factory: sessionmaker[Session]


async def _no_sleep(delay: float) -> None:
    return None


@pytest.fixture
def api() -> Iterator[ApiContext]:
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    test_sessionmaker = sessionmaker(bind=engine, expire_on_commit=False)
    with test_sessionmaker() as setup_session:
        setup_session.add(Admin(password_hash=hash_password(PASSWORD)))
        setup_session.commit()

    state_names = (
        "session_factory",
        "session_store",
        "rate_limiter",
        "started_at",
        "telegram_adapter",
        "bot_configured",
        "notification_test_ids",
    )
    previous_state = {name: getattr(app.state, name) for name in state_names}
    previous_overrides = app.dependency_overrides.copy()
    try:
        app.state.session_factory = test_sessionmaker
        app.state.session_store = SessionStore()
        app.state.rate_limiter = LoginRateLimiter()
        app.state.started_at = time.monotonic() - 5.0
        app.state.telegram_adapter = TelegramAdapter(
            api_id=None, api_hash=None, client=FakeTelegramClient(), sleep=_no_sleep
        )
        app.state.bot_configured = False
        app.state.notification_test_ids = itertools.count(start=-1, step=-1)
        app.dependency_overrides.clear()
        with TestClient(app, base_url="https://testserver") as client:
            response = client.post("/auth/login", json={"password": PASSWORD})
            assert response.status_code == 200
            yield ApiContext(client=client, session_factory=test_sessionmaker)
    finally:
        app.dependency_overrides.clear()
        app.dependency_overrides.update(previous_overrides)
        for name, value in previous_state.items():
            setattr(app.state, name, value)
        engine.dispose()


def _seed(api: ApiContext, *, matched_at: datetime) -> None:
    with api.session_factory() as session:
        source = Source(name="Grupo", telegram_chat_id="-1001")
        rule = Rule(name="Notebooks", include_terms="notebook")
        recipient = Recipient(name="Gabriel", telegram_chat_id="101", allowlisted=True)
        session.add_all([source, rule, recipient])
        session.flush()
        match = Match(
            source_id=source.id,
            rule_id=rule.id,
            message_text="Notebook por R$ 100,00",
            price_cents=10_000,
            matched_at=matched_at,
        )
        session.add(match)
        session.flush()
        session.add(
            Delivery(
                match_id=match.id,
                recipient_id=recipient.id,
                status="sent",
                delivered_at=matched_at + timedelta(seconds=5),
            )
        )
        increment_counter(session, MetricReason.SEEN, source_id=source.id)
        session.commit()


def _every_datetime_value(payload: object) -> Iterator[tuple[str, object]]:
    """Yield `(field, value)` for every `*_at` field anywhere in a JSON payload."""
    if isinstance(payload, dict):
        for key, value in payload.items():
            if key.endswith("_at"):
                yield key, value
            yield from _every_datetime_value(value)
    elif isinstance(payload, list):
        for item in payload:
            yield from _every_datetime_value(item)


@pytest.mark.parametrize("stored", [MATCH_INSTANT, MATCH_INSTANT.replace(tzinfo=None)])
def test_matches_serialize_utc_with_z_even_though_sqlite_returns_naive(
    api: ApiContext, stored: datetime
) -> None:
    _seed(api, matched_at=stored)

    (match,) = api.client.get("/matches").json()

    assert match["matched_at"] == MATCH_ISO
    assert match["deliveries"][0]["delivered_at"] == "2026-09-20T01:43:05Z"


@pytest.mark.parametrize("path", ["/matches", "/rules", "/sources", "/recipients", "/metrics"])
def test_every_datetime_field_of_every_list_endpoint_ends_with_z(
    api: ApiContext, path: str
) -> None:
    _seed(api, matched_at=MATCH_INSTANT)

    payload = api.client.get(path).json()

    found = list(_every_datetime_value(payload))
    assert found, f"{path} was expected to expose at least one *_at field"
    for field, value in found:
        assert isinstance(value, str), f"{path} {field}"
        assert UTC_DATETIME.match(value), f"{path} {field} has no explicit UTC: {value!r}"


def test_created_rule_and_source_and_recipient_answer_with_z(api: ApiContext) -> None:
    csrf = api.client.post("/auth/login", json={"password": PASSWORD}).json()["csrf_token"]
    headers = {"x-csrf-token": csrf}
    created = [
        api.client.post("/rules", json={"name": "R", "include_terms": "x"}, headers=headers),
        api.client.post("/sources", json={"name": "S", "telegram_chat_id": "-1"}, headers=headers),
        api.client.post(
            "/recipients",
            json={"name": "D", "telegram_chat_id": "1", "allowlisted": True},
            headers=headers,
        ),
    ]

    for response in created:
        assert response.status_code == 201, response.text
        assert UTC_DATETIME.match(response.json()["created_at"]), response.json()


def test_a_datetime_with_another_offset_is_converted_to_utc_not_relabelled() -> None:
    brasilia = datetime(2026, 9, 19, 22, 43, tzinfo=timezone(timedelta(hours=-3)))

    assert ensure_utc(brasilia) == MATCH_INSTANT
    assert format_utc(brasilia) == MATCH_ISO
    assert format_utc(MATCH_INSTANT.replace(tzinfo=None)) == MATCH_ISO


def test_match_sse_event_carries_matched_at_with_z(api: ApiContext) -> None:
    _seed(api, matched_at=MATCH_INSTANT)
    with api.session_factory() as session:
        # A fresh load, exactly what the pipeline sees after `session.commit()`.
        match = session.query(Match).one()
    assert match.matched_at.tzinfo is None  # the SQLite shape that caused the bug

    result = ProcessResult(match=match, reason=None, deliveries_sent=1)
    event = build_match_event(result)

    assert event is not None
    assert event["matched_at"] == MATCH_ISO

    broker = EventBroker()
    publish_match_event(broker, result)
    (published,) = broker.subscribe(last_event_id=0).backlog
    wire = _format_event(published)
    data_line = next(line for line in wire.split("\n") if line.startswith("data:"))
    assert json.loads(data_line.removeprefix("data:"))["matched_at"] == MATCH_ISO


def test_no_response_model_declares_a_bare_datetime() -> None:
    """The guard: a new `created_at: datetime` would bring the bug back."""
    routers = Path(__file__).resolve().parents[1] / "app" / "routers"
    offenders: list[str] = []
    for path in sorted(routers.glob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for cls in (node for node in ast.walk(tree) if isinstance(node, ast.ClassDef)):
            for statement in cls.body:
                if not isinstance(statement, ast.AnnAssign):
                    continue
                names = {n.id for n in ast.walk(statement.annotation) if isinstance(n, ast.Name)}
                if "datetime" in names:
                    offenders.append(f"{path.name}:{statement.lineno} {cls.name}")
    assert offenders == [], f"use UtcDatetime (app/utc.py) instead of datetime: {offenders}"
