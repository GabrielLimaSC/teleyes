from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.main import app, get_db
from auth.hashing import hash_password
from auth.rate_limit import LoginRateLimiter
from auth.session import SessionStore
from models import Admin
from models.base import Base

PASSWORD = "correct horse battery staple"


@pytest.fixture
def client() -> Iterator[TestClient]:
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

    app.dependency_overrides[get_db] = override_get_db
    app.state.session_store = SessionStore()
    app.state.rate_limiter = LoginRateLimiter()

    with TestClient(app, base_url="https://testserver") as test_client:
        yield test_client

    app.dependency_overrides.clear()


def login(client: TestClient) -> str:
    response = client.post("/auth/login", json={"password": PASSWORD})
    assert response.status_code == 200
    return response.json()["csrf_token"]


ANONYMOUS_ROUTES = [
    ("GET", "/rules", None),
    ("POST", "/rules", {"name": "Promo", "include_terms": "promo"}),
    ("PATCH", "/rules/1", {"name": "Atualizada"}),
    ("POST", "/rules/1/pause", None),
    ("DELETE", "/rules/1", None),
    ("DELETE", "/rules/1/matches", None),
    ("GET", "/sources", None),
    ("POST", "/sources", {"name": "Grupo", "telegram_chat_id": "-1001"}),
    ("PATCH", "/sources/1", {"name": "Atualizado"}),
    ("POST", "/sources/1/pause", None),
    ("DELETE", "/sources/1", None),
    ("GET", "/recipients", None),
    ("POST", "/recipients", {"name": "Gabriel", "telegram_chat_id": "123"}),
    ("PATCH", "/recipients/1", {"name": "Atualizado"}),
    ("POST", "/recipients/1/pause", None),
    ("DELETE", "/recipients/1", None),
]


@pytest.mark.parametrize(("method", "path", "payload"), ANONYMOUS_ROUTES)
def test_every_configuration_route_rejects_anonymous_access(
    client: TestClient,
    method: str,
    path: str,
    payload: dict[str, object] | None,
) -> None:
    response = client.request(method, path, json=payload)

    assert response.status_code == 401


MUTATION_ROUTES = [route for route in ANONYMOUS_ROUTES if route[0] != "GET"]


@pytest.mark.parametrize(("method", "path", "payload"), MUTATION_ROUTES)
def test_every_configuration_mutation_requires_csrf(
    client: TestClient,
    method: str,
    path: str,
    payload: dict[str, object] | None,
) -> None:
    login(client)

    response = client.request(method, path, json=payload)

    assert response.status_code == 403


def test_rule_crud_over_http(client: TestClient) -> None:
    csrf = login(client)
    headers = {"x-csrf-token": csrf}

    created = client.post(
        "/rules",
        json={
            "name": "Notebook",
            "include_terms": "notebook,laptop",
            "exclude_terms": "usado",
            "max_price_cents": 350_000,
        },
        headers=headers,
    )
    assert created.status_code == 201
    rule_id = created.json()["id"]
    assert created.json()["active"] is True

    listed = client.get("/rules")
    assert [rule["id"] for rule in listed.json()] == [rule_id]

    updated = client.patch(
        f"/rules/{rule_id}",
        json={"name": "Notebook gamer", "max_price_cents": 400_000},
        headers=headers,
    )
    assert updated.status_code == 200
    assert updated.json()["name"] == "Notebook gamer"
    assert updated.json()["max_price_cents"] == 400_000

    paused = client.post(f"/rules/{rule_id}/pause", headers=headers)
    assert paused.status_code == 200
    assert paused.json()["active"] is False
    assert client.get("/rules").json() == []
    assert [rule["id"] for rule in client.get("/rules?include_inactive=true").json()] == [
        rule_id
    ]

    deleted = client.delete(f"/rules/{rule_id}", headers=headers)
    assert deleted.status_code == 204
    assert client.get("/rules?include_inactive=true").json() == []


def test_rule_validation_error_becomes_422(client: TestClient) -> None:
    csrf = login(client)

    response = client.post(
        "/rules",
        json={"name": "Inválida", "include_terms": "   "},
        headers={"x-csrf-token": csrf},
    )

    assert response.status_code == 422
    assert client.get("/rules?include_inactive=true").json() == []


def test_source_crud_over_http(client: TestClient) -> None:
    csrf = login(client)
    headers = {"x-csrf-token": csrf}

    created = client.post(
        "/sources",
        json={"name": "Pelando", "telegram_chat_id": "-100111"},
        headers=headers,
    )
    assert created.status_code == 201
    source_id = created.json()["id"]
    assert created.json()["active"] is True

    assert [source["id"] for source in client.get("/sources").json()] == [source_id]

    updated = client.patch(
        f"/sources/{source_id}",
        json={"name": "Pelando Promoções", "telegram_chat_id": "-100222"},
        headers=headers,
    )
    assert updated.status_code == 200
    assert updated.json()["name"] == "Pelando Promoções"
    assert updated.json()["telegram_chat_id"] == "-100222"

    paused = client.post(f"/sources/{source_id}/pause", headers=headers)
    assert paused.status_code == 200
    assert paused.json()["active"] is False
    assert client.get("/sources").json() == []
    assert [
        source["id"] for source in client.get("/sources?include_inactive=true").json()
    ] == [source_id]

    deleted = client.delete(f"/sources/{source_id}", headers=headers)
    assert deleted.status_code == 204
    assert client.get("/sources?include_inactive=true").json() == []


def test_duplicate_source_chat_id_becomes_409(client: TestClient) -> None:
    csrf = login(client)
    headers = {"x-csrf-token": csrf}
    payload = {"name": "Grupo A", "telegram_chat_id": "-100111"}
    assert client.post("/sources", json=payload, headers=headers).status_code == 201

    response = client.post(
        "/sources",
        json={"name": "Grupo B", "telegram_chat_id": "-100111"},
        headers=headers,
    )

    assert response.status_code == 409
    assert len(client.get("/sources?include_inactive=true").json()) == 1


def test_recipient_crud_over_http(client: TestClient) -> None:
    csrf = login(client)
    headers = {"x-csrf-token": csrf}

    created = client.post(
        "/recipients",
        json={"name": "Gabriel", "telegram_chat_id": "999", "allowlisted": False},
        headers=headers,
    )
    assert created.status_code == 201
    recipient_id = created.json()["id"]
    assert created.json()["active"] is True
    assert created.json()["allowlisted"] is False

    assert [recipient["id"] for recipient in client.get("/recipients").json()] == [
        recipient_id
    ]

    updated = client.patch(
        f"/recipients/{recipient_id}",
        json={"name": "Gabriel Lima", "allowlisted": True},
        headers=headers,
    )
    assert updated.status_code == 200
    assert updated.json()["name"] == "Gabriel Lima"
    assert updated.json()["allowlisted"] is True

    paused = client.post(f"/recipients/{recipient_id}/pause", headers=headers)
    assert paused.status_code == 200
    assert paused.json()["active"] is False
    assert client.get("/recipients").json() == []
    assert [
        recipient["id"]
        for recipient in client.get("/recipients?include_inactive=true").json()
    ] == [recipient_id]

    deleted = client.delete(f"/recipients/{recipient_id}", headers=headers)
    assert deleted.status_code == 204
    assert client.get("/recipients?include_inactive=true").json() == []


def test_duplicate_recipient_chat_id_becomes_409(client: TestClient) -> None:
    csrf = login(client)
    headers = {"x-csrf-token": csrf}
    payload = {"name": "Gabriel", "telegram_chat_id": "999"}
    assert client.post("/recipients", json=payload, headers=headers).status_code == 201

    response = client.post(
        "/recipients",
        json={"name": "Outro", "telegram_chat_id": "999"},
        headers=headers,
    )

    assert response.status_code == 409
    assert len(client.get("/recipients?include_inactive=true").json()) == 1


@pytest.mark.parametrize("resource", ["rules", "sources", "recipients"])
def test_update_of_missing_resource_becomes_404(
    client: TestClient, resource: str
) -> None:
    csrf = login(client)

    response = client.patch(
        f"/{resource}/999",
        json={"name": "Não existe"},
        headers={"x-csrf-token": csrf},
    )

    assert response.status_code == 404
