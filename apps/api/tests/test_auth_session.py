from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.main import SESSION_COOKIE_NAME, app, get_db
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
    app.state.rate_limiter = LoginRateLimiter(max_attempts=3, window_seconds=60.0)

    # Secure cookies are only sent back by the client over https.
    with TestClient(app, base_url="https://testserver") as test_client:
        yield test_client

    app.dependency_overrides.clear()


def test_login_with_correct_password_sets_httponly_secure_samesite_cookie(
    client: TestClient,
) -> None:
    response = client.post("/auth/login", json={"password": PASSWORD})

    assert response.status_code == 200
    assert "csrf_token" in response.json()

    set_cookie = response.headers["set-cookie"]
    assert SESSION_COOKIE_NAME in set_cookie
    assert "HttpOnly" in set_cookie
    assert "Secure" in set_cookie
    assert "SameSite=strict" in set_cookie.lower() or "samesite=strict" in set_cookie.lower()


def test_login_with_wrong_password_is_rejected_and_sets_no_cookie(client: TestClient) -> None:
    response = client.post("/auth/login", json={"password": "wrong"})

    assert response.status_code == 401
    assert "set-cookie" not in response.headers


def test_protected_route_rejects_without_session(client: TestClient) -> None:
    response = client.get("/auth/me")

    assert response.status_code == 401


def test_protected_route_accepts_with_valid_session(client: TestClient) -> None:
    client.post("/auth/login", json={"password": PASSWORD})

    response = client.get("/auth/me")

    assert response.status_code == 200


def test_mutation_without_csrf_token_is_rejected(client: TestClient) -> None:
    client.post("/auth/login", json={"password": PASSWORD})

    response = client.post("/auth/logout")

    assert response.status_code == 403


def test_mutation_with_correct_csrf_token_succeeds(client: TestClient) -> None:
    login_response = client.post("/auth/login", json={"password": PASSWORD})
    csrf_token = login_response.json()["csrf_token"]

    response = client.post("/auth/logout", headers={"x-csrf-token": csrf_token})

    assert response.status_code == 200


def test_mutation_with_wrong_csrf_token_is_rejected(client: TestClient) -> None:
    client.post("/auth/login", json={"password": PASSWORD})

    response = client.post("/auth/logout", headers={"x-csrf-token": "not-the-real-token"})

    assert response.status_code == 403


def test_repeated_wrong_passwords_trigger_temporary_lockout(client: TestClient) -> None:
    for _ in range(3):
        response = client.post("/auth/login", json={"password": "wrong"})
        assert response.status_code == 401

    locked_response = client.post("/auth/login", json={"password": PASSWORD})

    assert locked_response.status_code == 429
