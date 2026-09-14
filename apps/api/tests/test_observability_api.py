import itertools
import time
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, create_engine, event
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.main import app
from app.routers.notifications import BotNotifierFactory, get_bot_notifier_factory
from auth.hashing import hash_password
from auth.rate_limit import LoginRateLimiter
from auth.session import SessionStore
from models import Admin, Delivery, Match, Recipient, Rule, Source
from models.base import Base
from packages.metrics.counters import MetricReason, increment_counter
from packages.notifications.bot import BotNotifier
from packages.notifications.fakes import FakeBotClient
from packages.telegram.adapter import AdapterState, TelegramAdapter
from packages.telegram.fakes import FakeTelegramClient

PASSWORD = "correct horse battery staple"


@dataclass
class ApiContext:
    client: TestClient
    engine: Engine
    session_factory: sessionmaker[Session]


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
            api_id=None,
            api_hash=None,
            client=FakeTelegramClient(),
            sleep=_no_sleep,
        )
        app.state.bot_configured = False
        app.state.notification_test_ids = itertools.count(start=-1, step=-1)
        app.dependency_overrides.clear()

        with TestClient(app, base_url="https://testserver") as client:
            yield ApiContext(client=client, engine=engine, session_factory=test_sessionmaker)
    finally:
        app.dependency_overrides.clear()
        app.dependency_overrides.update(previous_overrides)
        for name, value in previous_state.items():
            setattr(app.state, name, value)
        engine.dispose()


async def _no_sleep(delay: float) -> None:
    return None


def _login(api: ApiContext) -> str:
    response = api.client.post("/auth/login", json={"password": PASSWORD})
    assert response.status_code == 200
    return response.json()["csrf_token"]


def _seed_matches(api: ApiContext) -> dict[str, int]:
    now = datetime.now(UTC)
    with api.session_factory() as session:
        source_a = Source(name="Grupo A", telegram_chat_id="-1001")
        source_b = Source(name="Grupo B", telegram_chat_id="-1002")
        rule_a = Rule(name="Notebooks", include_terms="notebook")
        rule_b = Rule(name="Celulares", include_terms="celular")
        recipient_a = Recipient(
            name="Gabriel", telegram_chat_id="101", active=True, allowlisted=True
        )
        recipient_b = Recipient(
            name="Destinatária", telegram_chat_id="202", active=True, allowlisted=True
        )
        session.add_all([source_a, source_b, rule_a, rule_b, recipient_a, recipient_b])
        session.flush()

        match_a = Match(
            source_id=source_a.id,
            rule_id=rule_a.id,
            message_text="Notebook por R$ 100,00",
            price_cents=10_000,
            message_link="https://t.me/grupo/1",
            matched_at=now,
        )
        match_b = Match(
            source_id=source_b.id,
            rule_id=rule_a.id,
            message_text="Notebook por R$ 250,00",
            price_cents=25_000,
            matched_at=now,
        )
        match_c = Match(
            source_id=source_a.id,
            rule_id=rule_b.id,
            message_text="Celular sem preço informado",
            price_cents=None,
            matched_at=now,
        )
        session.add_all([match_a, match_b, match_c])
        session.flush()
        session.add_all(
            [
                Delivery(
                    match_id=match_a.id,
                    recipient_id=recipient_a.id,
                    status="sent",
                    delivered_at=now,
                ),
                Delivery(
                    match_id=match_a.id,
                    recipient_id=recipient_b.id,
                    status="failed",
                ),
                Delivery(
                    match_id=match_b.id,
                    recipient_id=recipient_b.id,
                    status="pending",
                ),
            ]
        )
        session.commit()
        return {
            "source_a": source_a.id,
            "source_b": source_b.id,
            "rule_a": rule_a.id,
            "rule_b": rule_b.id,
            "recipient_a": recipient_a.id,
            "recipient_b": recipient_b.id,
            "match_a": match_a.id,
            "match_b": match_b.id,
            "match_c": match_c.id,
        }


def _response_ids(response_data: list[dict[str, object]]) -> set[int]:
    result: set[int] = set()
    for item in response_data:
        match_id = item["id"]
        assert isinstance(match_id, int)
        result.add(match_id)
    return result


def test_observability_routes_enforce_auth_and_notification_enforces_csrf(
    api: ApiContext,
) -> None:
    assert api.client.get("/matches").status_code == 401
    assert api.client.get("/metrics").status_code == 401
    assert (
        api.client.post(
            "/notifications/test", json={"chat_id": "101", "text": "Teste"}
        ).status_code
        == 401
    )

    _login(api)
    without_csrf = api.client.post(
        "/notifications/test", json={"chat_id": "101", "text": "Teste"}
    )
    wrong_csrf = api.client.post(
        "/notifications/test",
        json={"chat_id": "101", "text": "Teste"},
        headers={"x-csrf-token": "wrong"},
    )

    assert without_csrf.status_code == 403
    assert wrong_csrf.status_code == 403


def test_matches_list_includes_deliveries_without_n_plus_one(api: ApiContext) -> None:
    ids = _seed_matches(api)
    _login(api)
    statements: list[str] = []

    def capture_statement(
        connection: object,
        cursor: object,
        statement: str,
        parameters: object,
        context: object,
        executemany: bool,
    ) -> None:
        statements.append(statement)

    event.listen(api.engine, "before_cursor_execute", capture_statement)
    try:
        response = api.client.get("/matches")
    finally:
        event.remove(api.engine, "before_cursor_execute", capture_statement)

    assert response.status_code == 200
    assert len(statements) == 1
    assert len(response.json()) == 3
    assert _response_ids(response.json()) == {
        ids["match_a"],
        ids["match_b"],
        ids["match_c"],
    }
    match_a = next(item for item in response.json() if item["id"] == ids["match_a"])
    assert {delivery["status"] for delivery in match_a["deliveries"]} == {"sent", "failed"}
    match_c = next(item for item in response.json() if item["id"] == ids["match_c"])
    assert match_c["deliveries"] == []


def test_every_match_filter_and_price_range(api: ApiContext) -> None:
    ids = _seed_matches(api)
    _login(api)
    cases = [
        ({"rule_id": ids["rule_a"]}, {ids["match_a"], ids["match_b"]}),
        ({"source_id": ids["source_a"]}, {ids["match_a"], ids["match_c"]}),
        ({"recipient_id": ids["recipient_b"]}, {ids["match_a"], ids["match_b"]}),
        ({"price_cents": 10_000}, {ids["match_a"]}),
        ({"min_price_cents": 15_000}, {ids["match_b"]}),
        ({"max_price_cents": 15_000}, {ids["match_a"]}),
        ({"min_price_cents": 10_000, "max_price_cents": 25_000}, {ids["match_a"], ids["match_b"]}),
        ({"delivery_status": "sent"}, {ids["match_a"]}),
        (
            {"recipient_id": ids["recipient_b"], "delivery_status": "sent"},
            set(),
        ),
        (
            {"recipient_id": ids["recipient_a"], "delivery_status": "sent"},
            {ids["match_a"]},
        ),
    ]

    for query, expected_ids in cases:
        response = api.client.get("/matches", params=query)
        assert response.status_code == 200
        assert _response_ids(response.json()) == expected_ids


def test_invalid_match_price_range_becomes_422(api: ApiContext) -> None:
    _login(api)

    response = api.client.get(
        "/matches", params={"min_price_cents": 20_000, "max_price_cents": 10_000}
    )

    assert response.status_code == 422


def test_matches_sort_by_price_puts_nulls_last_regardless_of_direction(
    api: ApiContext,
) -> None:
    """S7-07: match_a=10_000, match_b=25_000, match_c=None (see _seed_matches)."""
    ids = _seed_matches(api)
    _login(api)

    def ordered_ids(sort: str) -> list[int]:
        response = api.client.get("/matches", params={"sort": sort})
        assert response.status_code == 200
        return [item["id"] for item in response.json()]

    assert ordered_ids("price_asc") == [ids["match_a"], ids["match_b"], ids["match_c"]]
    assert ordered_ids("price_desc") == [ids["match_b"], ids["match_a"], ids["match_c"]]


def test_matches_sort_defaults_to_recency_and_rejects_unknown_values(
    api: ApiContext,
) -> None:
    ids = _seed_matches(api)
    _login(api)

    default_response = api.client.get("/matches")
    assert default_response.status_code == 200
    # Same order as before S7-07 existed: most recently inserted first.
    assert [item["id"] for item in default_response.json()] == [
        ids["match_c"],
        ids["match_b"],
        ids["match_a"],
    ]

    invalid_response = api.client.get("/matches", params={"sort": "price"})
    assert invalid_response.status_code == 422


def test_metrics_are_authenticated_and_contain_only_aggregates(api: ApiContext) -> None:
    with api.session_factory() as session:
        source = Source(name="Grupo", telegram_chat_id="-1009")
        session.add(source)
        session.flush()
        increment_counter(session, MetricReason.SEEN, source_id=source.id)
        increment_counter(session, MetricReason.SEEN, source_id=source.id)
        increment_counter(session, MetricReason.BLOCKED, source_id=source.id)
        session.commit()
    _login(api)

    response = api.client.get("/metrics")

    assert response.status_code == 200
    assert response.json() == [
        {
            "source_id": source.id,
            "reason": MetricReason.BLOCKED.value,
            "count": 1,
            "updated_at": response.json()[0]["updated_at"],
        },
        {
            "source_id": source.id,
            "reason": MetricReason.SEEN.value,
            "count": 2,
            "updated_at": response.json()[1]["updated_at"],
        },
    ]
    assert "CONTEUDO REJEITADO NAO PODE APARECER" not in response.text
    assert all(
        set(item) == {"source_id", "reason", "count", "updated_at"}
        for item in response.json()
    )


def test_health_remains_public_and_reports_not_configured_components(api: ApiContext) -> None:
    response = api.client.get("/health")

    assert response.status_code == 200
    assert response.json()["status"] == "ok"
    assert response.json()["env"]
    assert response.json()["version"] == "0.1.0"
    assert response.json()["uptime_seconds"] >= 5.0
    assert response.json()["telegram"] == {
        "configured": False,
        "state": AdapterState.NOT_CONFIGURED.value,
    }
    assert response.json()["bot"] == {"configured": False, "state": "not_configured"}


@pytest.mark.parametrize(
    "adapter_state",
    [
        AdapterState.CONNECTING,
        AdapterState.CONNECTED,
        AdapterState.RECONNECTING,
        AdapterState.BLOCKED,
    ],
)
def test_health_reports_configured_runtime_states(
    api: ApiContext, adapter_state: AdapterState
) -> None:
    adapter = TelegramAdapter(
        api_id=123,
        api_hash="test-hash",
        client=FakeTelegramClient(),
        sleep=_no_sleep,
    )
    adapter.state = adapter_state
    app.state.telegram_adapter = adapter
    app.state.bot_configured = True

    response = api.client.get("/health")

    assert response.status_code == 200
    assert response.json()["telegram"] == {
        "configured": True,
        "state": adapter_state.value,
    }
    assert response.json()["bot"] == {"configured": True, "state": "configured"}
    assert "test-hash" not in response.text


def _seed_notification_recipients(api: ApiContext) -> None:
    with api.session_factory() as session:
        session.add_all(
            [
                Recipient(
                    name="Permitido",
                    telegram_chat_id="101",
                    active=True,
                    allowlisted=True,
                ),
                Recipient(
                    name="Pausado",
                    telegram_chat_id="202",
                    active=False,
                    allowlisted=True,
                ),
                Recipient(
                    name="Sem allowlist",
                    telegram_chat_id="303",
                    active=True,
                    allowlisted=False,
                ),
            ]
        )
        session.commit()


def _override_notifier(api: ApiContext, fake_client: FakeBotClient, *, configured: bool) -> None:
    def dependency() -> BotNotifierFactory:
        def factory(allowlisted_chat_ids: set[str]) -> BotNotifier:
            return BotNotifier(
                bot_token="test-token" if configured else None,
                client=fake_client,
                allowlisted_chat_ids=allowlisted_chat_ids,
            )

        return factory

    app.dependency_overrides[get_bot_notifier_factory] = dependency


def test_notification_returns_not_configured_without_sending(api: ApiContext) -> None:
    _seed_notification_recipients(api)
    csrf = _login(api)
    fake_client = FakeBotClient()
    _override_notifier(api, fake_client, configured=False)

    response = api.client.post(
        "/notifications/test",
        json={"chat_id": "101", "text": "Teste seguro"},
        headers={"x-csrf-token": csrf},
    )

    assert response.status_code == 200
    assert response.json()["delivered"] is False
    assert response.json()["status"] == "not_configured"
    assert fake_client.sent == []


def test_notification_fake_succeeds_repeatedly_for_allowlisted_recipient(
    api: ApiContext,
) -> None:
    _seed_notification_recipients(api)
    csrf = _login(api)
    fake_client = FakeBotClient()
    _override_notifier(api, fake_client, configured=True)
    headers = {"x-csrf-token": csrf}
    payload = {"chat_id": "101", "text": "Teste seguro"}

    first = api.client.post("/notifications/test", json=payload, headers=headers)
    second = api.client.post("/notifications/test", json=payload, headers=headers)

    assert first.status_code == 200
    assert second.status_code == 200
    assert first.json()["status"] == second.json()["status"] == "sent"
    assert fake_client.sent == [("101", "Teste seguro"), ("101", "Teste seguro")]


@pytest.mark.parametrize(
    ("chat_id", "expected_status"),
    [("999", 404), ("202", 403), ("303", 403)],
)
def test_notification_refuses_unknown_inactive_or_non_allowlisted_recipient(
    api: ApiContext,
    chat_id: str,
    expected_status: int,
) -> None:
    _seed_notification_recipients(api)
    csrf = _login(api)
    fake_client = FakeBotClient()
    _override_notifier(api, fake_client, configured=True)

    response = api.client.post(
        "/notifications/test",
        json={"chat_id": chat_id, "text": "Teste seguro"},
        headers={"x-csrf-token": csrf},
    )

    assert response.status_code == expected_status
    assert fake_client.sent == []


def test_notification_delivery_failure_becomes_502_without_error_leak(
    api: ApiContext,
) -> None:
    _seed_notification_recipients(api)
    csrf = _login(api)
    fake_client = FakeBotClient(fail_for_chat_ids={"101"})
    _override_notifier(api, fake_client, configured=True)

    response = api.client.post(
        "/notifications/test",
        json={"chat_id": "101", "text": "Teste seguro"},
        headers={"x-csrf-token": csrf},
    )

    assert response.status_code == 502
    assert response.json() == {"detail": "notification delivery failed"}
    assert "test-token" not in response.text
