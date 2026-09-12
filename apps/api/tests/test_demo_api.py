from collections.abc import Iterator
from dataclasses import dataclass

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.main import app, get_db
from app.routers.notifications import BotNotifierFactory, get_bot_notifier_factory
from auth.hashing import hash_password
from auth.rate_limit import LoginRateLimiter
from auth.session import SessionStore
from models import Admin
from models.base import Base
from packages.events.broker import EventBroker
from packages.notifications.bot import BotNotifier
from packages.notifications.fakes import FakeBotClient
from packages.rules.dedupe import DedupeCache

PASSWORD = "correct horse battery staple"


@dataclass
class ApiContext:
    client: TestClient
    broker: EventBroker


@pytest.fixture
def api() -> Iterator[ApiContext]:
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    test_sessionmaker = sessionmaker(bind=engine)

    with test_sessionmaker() as setup_session:
        setup_session.add(Admin(password_hash=hash_password(PASSWORD)))
        setup_session.commit()

    def override_get_db() -> Iterator[Session]:
        with test_sessionmaker() as session:
            yield session

    def notifier_factory() -> BotNotifierFactory:
        def factory(allowlisted_chat_ids: set[str]) -> BotNotifier:
            return BotNotifier(
                bot_token=None,
                client=FakeBotClient(),
                allowlisted_chat_ids=allowlisted_chat_ids,
            )

        return factory

    state_names = ("session_store", "rate_limiter", "event_broker", "demo_dedupe_cache")
    previous_state = {name: getattr(app.state, name) for name in state_names}
    broker = EventBroker()

    try:
        app.dependency_overrides[get_db] = override_get_db
        app.dependency_overrides[get_bot_notifier_factory] = notifier_factory
        app.state.session_store = SessionStore()
        app.state.rate_limiter = LoginRateLimiter()
        app.state.event_broker = broker
        app.state.demo_dedupe_cache = DedupeCache()

        with TestClient(app, base_url="https://testserver") as client:
            yield ApiContext(client=client, broker=broker)
    finally:
        app.dependency_overrides.clear()
        for name, value in previous_state.items():
            setattr(app.state, name, value)
        engine.dispose()


def _login(api: ApiContext) -> str:
    response = api.client.post("/auth/login", json={"password": PASSWORD})
    assert response.status_code == 200
    return str(response.json()["csrf_token"])


def test_demo_page_is_served_without_authentication(api: ApiContext) -> None:
    response = api.client.get("/demo")

    assert response.status_code == 200
    assert "text/html" in response.headers["content-type"]
    assert "EventSource" in response.text


def test_simulate_message_requires_authentication(api: ApiContext) -> None:
    response = api.client.post(
        "/demo/messages",
        json={"source_id": 1, "rule_id": 1, "recipient_ids": [1], "text": "iphone"},
    )

    assert response.status_code == 401


def test_simulate_message_creates_a_match_and_publishes_it_to_the_feed(
    api: ApiContext,
) -> None:
    csrf = _login(api)
    headers = {"x-csrf-token": csrf}

    source_id = api.client.post(
        "/sources",
        json={"name": "Grupo Teste", "telegram_chat_id": "-100123"},
        headers=headers,
    ).json()["id"]
    rule_id = api.client.post(
        "/rules",
        json={"name": "iPhone", "include_terms": "iphone", "max_price_cents": 500_000},
        headers=headers,
    ).json()["id"]
    recipient_id = api.client.post(
        "/recipients",
        json={"name": "Gabriel", "telegram_chat_id": "999", "allowlisted": True},
        headers=headers,
    ).json()["id"]

    response = api.client.post(
        "/demo/messages",
        json={
            "source_id": source_id,
            "rule_id": rule_id,
            "recipient_ids": [recipient_id],
            "text": "Promoção iPhone 15 por R$ 3.899",
        },
        headers=headers,
    )

    assert response.status_code == 200
    body = response.json()
    assert body["match_id"] is not None
    assert body["reason"] is None
    assert body["deliveries_sent"] == 0  # sem BOT_TOKEN, notifier fica not_configured

    # subscribing after the fact and replaying from history proves the event was
    # actually published (not just returned in the HTTP response).
    subscription = api.broker.subscribe(last_event_id=0)
    assert len(subscription.backlog) == 1
    assert subscription.backlog[0].type == "match"
    assert subscription.backlog[0].data["match_id"] == body["match_id"]

    history = api.client.get("/matches").json()
    assert len(history) == 1
    assert history[0]["id"] == body["match_id"]
    assert history[0]["message_text"] == "Promoção iPhone 15 por R$ 3.899"


def test_simulate_message_discard_is_not_published(api: ApiContext) -> None:
    csrf = _login(api)
    headers = {"x-csrf-token": csrf}

    source_id = api.client.post(
        "/sources",
        json={"name": "Grupo Teste", "telegram_chat_id": "-100123"},
        headers=headers,
    ).json()["id"]
    rule_id = api.client.post(
        "/rules",
        json={"name": "iPhone", "include_terms": "iphone"},
        headers=headers,
    ).json()["id"]
    recipient_id = api.client.post(
        "/recipients",
        json={"name": "Gabriel", "telegram_chat_id": "999", "allowlisted": True},
        headers=headers,
    ).json()["id"]

    response = api.client.post(
        "/demo/messages",
        json={
            "source_id": source_id,
            "rule_id": rule_id,
            "recipient_ids": [recipient_id],
            "text": "Samsung Galaxy em promoção",
        },
        headers=headers,
    )

    assert response.status_code == 200
    assert response.json()["match_id"] is None
    subscription = api.broker.subscribe(last_event_id=0)
    assert subscription.backlog == []
    assert api.client.get("/matches").json() == []


def test_simulate_message_with_unknown_source_becomes_404(api: ApiContext) -> None:
    csrf = _login(api)
    headers = {"x-csrf-token": csrf}
    rule_id = api.client.post(
        "/rules",
        json={"name": "iPhone", "include_terms": "iphone"},
        headers=headers,
    ).json()["id"]
    recipient_id = api.client.post(
        "/recipients",
        json={"name": "Gabriel", "telegram_chat_id": "999"},
        headers=headers,
    ).json()["id"]

    response = api.client.post(
        "/demo/messages",
        json={
            "source_id": 999,
            "rule_id": rule_id,
            "recipient_ids": [recipient_id],
            "text": "iphone",
        },
        headers=headers,
    )

    assert response.status_code == 404
