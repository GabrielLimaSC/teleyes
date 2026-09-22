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


class FakeClock:
    """A controllable clock for `SessionStore(clock=...)` — real time would
    make the renew-by-activity test either flaky or take actual minutes."""

    def __init__(self, start: float = 0.0) -> None:
        self._now = start

    def __call__(self) -> float:
        return self._now

    def advance(self, seconds: float) -> None:
        self._now += seconds


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


# S13-08: renewal by activity, exercised directly against `SessionStore` with
# a fake clock — the fixed-1h-from-creation bug lived here, not in the HTTP
# layer, so the regression test belongs at this level too.


def test_get_session_renews_expiry_on_each_valid_read() -> None:
    clock = FakeClock()
    store = SessionStore(ttl_seconds=100.0, clock=clock)
    record = store.create_session(admin_id=1)

    clock.advance(80.0)  # inside the original 100s window
    assert store.get_session(record.session_id) is not None  # renews: now valid until t=180

    # Total elapsed since creation is now 160s — past the *original* fixed
    # TTL counted from `created_at` — but the read above pushed the sliding
    # window to t=180, so the session must still be alive.
    clock.advance(80.0)
    assert store.get_session(record.session_id) is not None  # renews again: valid until t=260

    clock.advance(80.0)
    assert store.get_session(record.session_id) is not None  # still fine: t=240 < t=260


def test_get_session_expires_after_ttl_seconds_of_no_activity() -> None:
    clock = FakeClock()
    store = SessionStore(ttl_seconds=100.0, clock=clock)
    record = store.create_session(admin_id=1)

    clock.advance(50.0)
    assert store.get_session(record.session_id) is not None  # renews: valid until t=150

    clock.advance(150.0)  # no read in between — 150s of pure inactivity
    assert store.get_session(record.session_id) is None


def test_get_session_forgets_an_expired_session_it_deleted() -> None:
    clock = FakeClock()
    store = SessionStore(ttl_seconds=10.0, clock=clock)
    record = store.create_session(admin_id=1)

    clock.advance(11.0)
    assert store.get_session(record.session_id) is None
    # A second lookup after the first already evicted it: still None, not a
    # crash on a missing dict entry.
    assert store.get_session(record.session_id) is None


def test_default_ttl_is_the_24h_inactivity_window() -> None:
    # Pins the documented default so a future edit can't silently shrink it
    # back toward the old fixed-1h behaviour without a test noticing.
    assert SessionStore().__dict__["_ttl_seconds"] == 86400.0


def test_session_created_via_login_survives_past_the_old_fixed_1h_ttl_with_activity(
    client: TestClient,
) -> None:
    """End-to-end version of the same bug: with the real HTTP session store,
    activity past the old 1h-from-creation mark must keep working."""
    clock = FakeClock()
    app.state.session_store = SessionStore(ttl_seconds=100.0, clock=clock)

    login_response = client.post("/auth/login", json={"password": PASSWORD})
    csrf_token = login_response.json()["csrf_token"]

    # Past the fixed-TTL-from-creation mark, but each `/auth/me` call in
    # between renews the sliding window.
    for _ in range(3):
        clock.advance(80.0)
        assert client.get("/auth/me").status_code == 200

    response = client.post("/auth/logout", headers={"x-csrf-token": csrf_token})
    assert response.status_code == 200
