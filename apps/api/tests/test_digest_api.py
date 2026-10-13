"""S14-04 (F4): `GET/PUT /digest` over HTTP — auth/CSRF (covered generically
by `test_configuration_api.py`'s `ANONYMOUS_ROUTES`/`MUTATION_ROUTES`), field
validation, and the "Próximo envio"/queue shape the panel reads.
"""

from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.main import app, get_db
from app.pipeline import DELIVERY_KIND_DIGEST
from auth.hashing import hash_password
from auth.rate_limit import LoginRateLimiter
from auth.session import SessionStore
from models import Admin, Delivery, Match, Recipient, Rule, Source
from models.base import Base

PASSWORD = "correct horse battery staple"


@dataclass
class ApiContext:
    client: TestClient
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

    def override_get_db() -> Iterator[Session]:
        with test_sessionmaker() as session:
            yield session

    app.dependency_overrides[get_db] = override_get_db
    app.state.session_store = SessionStore()
    app.state.rate_limiter = LoginRateLimiter()

    with TestClient(app, base_url="https://testserver") as test_client:
        yield ApiContext(client=test_client, session_factory=test_sessionmaker)

    app.dependency_overrides.clear()


def _login(api: ApiContext) -> str:
    response = api.client.post("/auth/login", json={"password": PASSWORD})
    assert response.status_code == 200
    return response.json()["csrf_token"]


def test_get_digest_defaults_to_disabled_with_an_empty_queue(api: ApiContext) -> None:
    _login(api)

    response = api.client.get("/digest")

    assert response.status_code == 200
    body = response.json()
    assert body["enabled"] is False
    assert body["send_at_local"] == "09:00"
    assert body["top_n"] == 5
    assert body["mute_individual"] is False
    assert body["queue_count"] == 0
    assert body["queue"] == []
    assert body["next_run_at_utc"].endswith("Z")


def test_put_digest_persists_and_get_reflects_it(api: ApiContext) -> None:
    csrf = api.client.post("/auth/login", json={"password": PASSWORD}).json()["csrf_token"]
    headers = {"x-csrf-token": csrf}

    put_response = api.client.put(
        "/digest",
        json={"enabled": True, "send_at_local": "21:15", "top_n": 3, "mute_individual": True},
        headers=headers,
    )
    assert put_response.status_code == 200
    assert put_response.json()["send_at_local"] == "21:15"
    assert put_response.json()["top_n"] == 3

    get_response = api.client.get("/digest")
    body = get_response.json()
    assert body["enabled"] is True
    assert body["send_at_local"] == "21:15"
    assert body["top_n"] == 3
    assert body["mute_individual"] is True


@pytest.mark.parametrize(
    "payload",
    [
        {"enabled": True, "send_at_local": "25:00", "top_n": 5, "mute_individual": False},
        {"enabled": True, "send_at_local": "9h00", "top_n": 5, "mute_individual": False},
        {"enabled": True, "send_at_local": "09:00", "top_n": 0, "mute_individual": False},
        {"enabled": True, "send_at_local": "09:00", "top_n": 51, "mute_individual": False},
    ],
)
def test_put_digest_rejects_invalid_fields(api: ApiContext, payload: dict[str, object]) -> None:
    csrf = api.client.post("/auth/login", json={"password": PASSWORD}).json()["csrf_token"]

    response = api.client.put("/digest", json=payload, headers={"x-csrf-token": csrf})

    assert response.status_code == 422


def test_get_digest_lists_the_pending_queue_cheapest_first(api: ApiContext) -> None:
    _login(api)
    with api.session_factory() as session:
        source = Source(name="Grupo", telegram_chat_id="-100123")
        rule = Rule(name="RTX 5070", include_terms="rtx 5070")
        recipient = Recipient(name="Gabriel", telegram_chat_id="999", allowlisted=True)
        session.add_all([source, rule, recipient])
        session.flush()
        expensive = Match(
            source_id=source.id,
            rule_id=rule.id,
            telegram_message_id=1,
            message_text="RTX 5070 por R$ 3.000",
            price_cents=300_000,
            matched_at=datetime.now(UTC),
        )
        cheap = Match(
            source_id=source.id,
            rule_id=rule.id,
            telegram_message_id=2,
            message_text="RTX 5070 por R$ 1.000",
            price_cents=100_000,
            matched_at=datetime.now(UTC),
        )
        session.add_all([expensive, cheap])
        session.flush()

        session.add_all(
            [
                Delivery(
                    match_id=expensive.id,
                    recipient_id=recipient.id,
                    kind=DELIVERY_KIND_DIGEST,
                    status="pending",
                ),
                Delivery(
                    match_id=cheap.id,
                    recipient_id=recipient.id,
                    kind=DELIVERY_KIND_DIGEST,
                    status="pending",
                ),
            ]
        )
        session.commit()

    response = api.client.get("/digest")

    assert response.status_code == 200
    body = response.json()
    assert body["queue_count"] == 2
    assert [item["match_id"] for item in body["queue"]] == [cheap.id, expensive.id]
