from collections.abc import Iterator
from datetime import UTC
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.config import get_settings
from app.main import SESSION_COOKIE_NAME, app, get_db
from auth.hashing import hash_password
from auth.rate_limit import LoginRateLimiter
from auth.session import (
    REMEMBER_TTL_SECONDS,
    TOUCH_INTERVAL_SECONDS,
    SessionStore,
    hash_token,
)
from models import Admin, AdminSession
from models.base import Base

PASSWORD = "correct horse battery staple"
DAY = 86400.0


class FakeClock:
    """A controllable clock for `SessionStore(clock=...)` — real time would
    make the renew-by-activity test either flaky or take actual minutes."""

    def __init__(self, start: float = 1_700_000_000.0) -> None:
        self._now = start

    def __call__(self) -> float:
        return self._now

    def advance(self, seconds: float) -> None:
        self._now += seconds


@pytest.fixture
def session_factory() -> Iterator[sessionmaker[Session]]:
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine)
    with factory() as setup_session:
        setup_session.add(Admin(password_hash=hash_password(PASSWORD)))
        setup_session.commit()
    yield factory


@pytest.fixture
def client(session_factory: sessionmaker[Session]) -> Iterator[TestClient]:
    def override_get_db() -> Iterator[Session]:
        with session_factory() as session:
            yield session

    app.dependency_overrides[get_db] = override_get_db
    app.state.session_store = SessionStore(session_factory)
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


def test_login_cookie_drops_secure_when_self_host_opts_out(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("SESSION_COOKIE_SECURE", "false")
    get_settings.cache_clear()
    try:
        response = client.post("/auth/login", json={"password": PASSWORD})
    finally:
        get_settings.cache_clear()

    assert response.status_code == 200
    set_cookie = response.headers["set-cookie"]
    assert "HttpOnly" in set_cookie
    assert "Secure" not in set_cookie


def test_login_cookie_stays_secure_when_the_flag_is_blank(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("SESSION_COOKIE_SECURE", "")
    get_settings.cache_clear()
    try:
        response = client.post("/auth/login", json={"password": PASSWORD})
    finally:
        get_settings.cache_clear()

    assert "Secure" in response.headers["set-cookie"]


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


def test_me_returns_the_same_csrf_token_as_login(client: TestClient) -> None:
    login = client.post("/auth/login", json={"password": PASSWORD})

    me = client.get("/auth/me")

    assert me.status_code == 200
    assert me.json()["csrf_token"] == login.json()["csrf_token"]
    assert isinstance(me.json()["admin_id"], int)
    assert "access-control-allow-origin" not in me.headers


def test_me_without_cookie_leaks_no_token(client: TestClient) -> None:
    response = client.get("/auth/me")

    assert response.status_code == 401
    assert "csrf_token" not in response.text


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


def test_get_session_renews_expiry_on_each_valid_read(
    session_factory: sessionmaker[Session],
) -> None:
    clock = FakeClock()
    store = SessionStore(session_factory, ttl_seconds=100.0, clock=clock)
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


def test_get_session_expires_after_ttl_seconds_of_no_activity(
    session_factory: sessionmaker[Session],
) -> None:
    clock = FakeClock()
    store = SessionStore(session_factory, ttl_seconds=100.0, clock=clock)
    record = store.create_session(admin_id=1)

    clock.advance(70.0)
    assert store.get_session(record.session_id) is not None  # renews: valid until t=170

    clock.advance(150.0)  # no read in between — 150s of pure inactivity
    assert store.get_session(record.session_id) is None


def test_get_session_forgets_an_expired_session_it_deleted(
    session_factory: sessionmaker[Session],
) -> None:
    clock = FakeClock()
    store = SessionStore(session_factory, ttl_seconds=10.0, clock=clock)
    record = store.create_session(admin_id=1)

    clock.advance(11.0)
    assert store.get_session(record.session_id) is None
    # A second lookup after the first already evicted it: still None, not a
    # crash on a missing dict entry.
    assert store.get_session(record.session_id) is None


def test_default_ttl_is_the_24h_inactivity_window(
    session_factory: sessionmaker[Session],
) -> None:
    # Pins the documented default so a future edit can't silently shrink it
    # back toward the old fixed-1h behaviour without a test noticing.
    assert SessionStore(session_factory).__dict__["_ttl_seconds"] == 86400.0


def test_session_created_via_login_survives_past_the_old_fixed_1h_ttl_with_activity(
    client: TestClient,
    session_factory: sessionmaker[Session],
) -> None:
    """End-to-end version of the same bug: with the real HTTP session store,
    activity past the old 1h-from-creation mark must keep working."""
    clock = FakeClock()
    app.state.session_store = SessionStore(session_factory, ttl_seconds=100.0, clock=clock)

    login_response = client.post("/auth/login", json={"password": PASSWORD})
    csrf_token = login_response.json()["csrf_token"]

    # Past the fixed-TTL-from-creation mark, but each `/auth/me` call in
    # between renews the sliding window.
    for _ in range(3):
        clock.advance(80.0)
        assert client.get("/auth/me").status_code == 200

    response = client.post("/auth/logout", headers={"x-csrf-token": csrf_token})
    assert response.status_code == 200


# S21-12: persistent sessions and "manter conectado".


def _cookie_attributes(set_cookie: str) -> dict[str, str]:
    attributes: dict[str, str] = {}
    for part in set_cookie.split(";"):
        name, _, value = part.strip().partition("=")
        attributes[name.lower()] = value
    return attributes


def test_login_without_remember_sets_a_browser_session_cookie(client: TestClient) -> None:
    response = client.post("/auth/login", json={"password": PASSWORD})

    cookie = _cookie_attributes(response.headers["set-cookie"])
    assert "max-age" not in cookie
    assert "expires" not in cookie
    assert "httponly" in cookie
    assert "secure" in cookie
    assert cookie["samesite"].lower() == "strict"


def test_login_with_remember_false_is_the_same_as_without(client: TestClient) -> None:
    response = client.post("/auth/login", json={"password": PASSWORD, "remember": False})

    assert "max-age" not in _cookie_attributes(response.headers["set-cookie"])


def test_login_with_remember_sets_a_30_day_cookie(client: TestClient) -> None:
    response = client.post("/auth/login", json={"password": PASSWORD, "remember": True})

    cookie = _cookie_attributes(response.headers["set-cookie"])
    assert cookie["max-age"] == str(30 * 86400)
    assert "httponly" in cookie
    assert "secure" in cookie
    assert cookie["samesite"].lower() == "strict"


def test_remember_cookie_still_follows_the_secure_flag(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("SESSION_COOKIE_SECURE", "false")
    get_settings.cache_clear()
    try:
        response = client.post("/auth/login", json={"password": PASSWORD, "remember": True})
    finally:
        get_settings.cache_clear()

    cookie = _cookie_attributes(response.headers["set-cookie"])
    assert "secure" not in cookie
    assert "max-age" in cookie


def test_the_cookie_token_is_never_stored_in_the_database(
    client: TestClient, session_factory: sessionmaker[Session]
) -> None:
    client.post("/auth/login", json={"password": PASSWORD, "remember": True})
    token = client.cookies[SESSION_COOKIE_NAME]
    csrf = client.get("/auth/me").json()["csrf_token"]

    with session_factory() as db:
        rows = db.scalars(select(AdminSession)).all()
        assert [row.id_hash for row in rows] == [hash_token(token)]
        assert rows[0].remember is True
        dump = repr([(c.name, getattr(rows[0], c.name)) for c in AdminSession.__table__.columns])
    assert token not in dump
    assert csrf not in dump


def test_session_survives_a_new_store_on_the_same_database(
    client: TestClient, session_factory: sessionmaker[Session]
) -> None:
    login = client.post("/auth/login", json={"password": PASSWORD})

    # The api restarting loses nothing but the process: a brand new store, same database.
    app.state.session_store = SessionStore(session_factory)

    me = client.get("/auth/me")
    assert me.status_code == 200
    assert me.json()["csrf_token"] == login.json()["csrf_token"]


def test_session_survives_a_new_process_on_a_database_file(tmp_path: Path) -> None:
    url = f"sqlite:///{tmp_path}/sessions.db"
    first_engine = create_engine(url)
    Base.metadata.create_all(first_engine)
    with sessionmaker(bind=first_engine)() as db:
        db.add(Admin(password_hash=hash_password(PASSWORD)))
        db.commit()

    record = SessionStore(sessionmaker(bind=first_engine)).create_session(admin_id=1, remember=True)
    first_engine.dispose()

    second_engine = create_engine(url)  # what a restarted api opens
    restored = SessionStore(sessionmaker(bind=second_engine)).get_session(record.session_id)

    assert restored is not None
    assert restored.admin_id == 1
    assert restored.remember is True
    assert restored.csrf_token == record.csrf_token
    second_engine.dispose()


def test_unknown_and_tampered_tokens_are_rejected(
    client: TestClient, session_factory: sessionmaker[Session]
) -> None:
    client.post("/auth/login", json={"password": PASSWORD})
    token = client.cookies[SESSION_COOKIE_NAME]

    store = SessionStore(session_factory)
    assert store.get_session(token + "x") is None
    assert store.get_session(hash_token(token)) is None  # the stored hash is not a credential
    assert store.get_session("") is None


def test_remember_session_expires_at_30_days_absolute(
    session_factory: sessionmaker[Session],
) -> None:
    clock = FakeClock()
    store = SessionStore(session_factory, clock=clock)
    record = store.create_session(admin_id=1, remember=True)

    # Activity along the way does not extend it.
    for _ in range(29):
        clock.advance(DAY)
        assert store.get_session(record.session_id) is not None
    clock.advance(DAY - 1)
    assert store.get_session(record.session_id) is not None
    clock.advance(1.0)
    assert store.get_session(record.session_id) is None
    with session_factory() as db:
        assert db.scalars(select(AdminSession)).all() == []


def test_remember_session_is_not_cut_by_the_24h_inactivity_window(
    session_factory: sessionmaker[Session],
) -> None:
    clock = FakeClock()
    store = SessionStore(session_factory, clock=clock)
    record = store.create_session(admin_id=1, remember=True)

    clock.advance(10 * DAY)  # ten days without opening the panel

    assert store.get_session(record.session_id) is not None


def test_default_session_slides_but_dies_after_24h_of_inactivity(
    session_factory: sessionmaker[Session],
) -> None:
    clock = FakeClock()
    store = SessionStore(session_factory, clock=clock)
    record = store.create_session(admin_id=1)
    assert record.expires_at - record.created_at == DAY
    assert REMEMBER_TTL_SECONDS == 30 * DAY

    for _ in range(5):  # five days of daily use, longer than any single window
        clock.advance(DAY - 3600)
        assert store.get_session(record.session_id) is not None
    clock.advance(DAY + 1)
    assert store.get_session(record.session_id) is None


def test_last_seen_is_written_at_most_once_per_minute(
    session_factory: sessionmaker[Session],
) -> None:
    clock = FakeClock()
    store = SessionStore(session_factory, clock=clock)
    record = store.create_session(admin_id=1)

    def last_seen() -> float:
        with session_factory() as db:
            row = db.scalars(select(AdminSession)).one()
            return row.last_seen_at.replace(tzinfo=UTC).timestamp()

    first = last_seen()
    for _ in range(10):
        clock.advance(TOUCH_INTERVAL_SECONDS / 20)
        assert store.get_session(record.session_id) is not None
    assert last_seen() == first  # 30s of requests: no write

    clock.advance(TOUCH_INTERVAL_SECONDS)
    assert store.get_session(record.session_id) is not None
    assert last_seen() > first  # a minute later: one write


def test_logout_deletes_the_row_and_the_old_cookie_stops_working(
    client: TestClient, session_factory: sessionmaker[Session]
) -> None:
    login = client.post("/auth/login", json={"password": PASSWORD, "remember": True})
    token = client.cookies[SESSION_COOKIE_NAME]

    response = client.post("/auth/logout", headers={"x-csrf-token": login.json()["csrf_token"]})

    assert response.status_code == 200
    with session_factory() as db:
        assert db.scalars(select(AdminSession)).all() == []
    client.cookies.set(SESSION_COOKIE_NAME, token)  # replaying the old cookie
    assert client.get("/auth/me").status_code == 401


def test_csrf_is_still_required_for_a_remembered_session(client: TestClient) -> None:
    login = client.post("/auth/login", json={"password": PASSWORD, "remember": True})

    assert client.post("/auth/logout").status_code == 403
    assert client.post("/auth/logout", headers={"x-csrf-token": "nope"}).status_code == 403
    csrf = login.json()["csrf_token"]
    assert client.post("/auth/logout", headers={"x-csrf-token": csrf}).status_code == 200


def test_csrf_token_of_one_session_does_not_work_on_another(
    client: TestClient, session_factory: sessionmaker[Session]
) -> None:
    other = SessionStore(session_factory).create_session(admin_id=1)
    client.post("/auth/login", json={"password": PASSWORD})

    response = client.post("/auth/logout", headers={"x-csrf-token": other.csrf_token})

    assert response.status_code == 403


def test_login_always_issues_a_fresh_token_and_drops_the_one_presented(
    client: TestClient, session_factory: sessionmaker[Session]
) -> None:
    planted = SessionStore(session_factory).create_session(admin_id=1)

    client.post(
        "/auth/login",
        json={"password": PASSWORD},
        headers={"cookie": f"{SESSION_COOKIE_NAME}={planted.session_id}"},
    )

    assert client.cookies[SESSION_COOKIE_NAME] != planted.session_id
    assert SessionStore(session_factory).get_session(planted.session_id) is None


def test_creating_a_session_sweeps_expired_ones(session_factory: sessionmaker[Session]) -> None:
    clock = FakeClock()
    store = SessionStore(session_factory, clock=clock)
    store.create_session(admin_id=1)
    store.create_session(admin_id=1, remember=True)

    clock.advance(2 * DAY)  # the plain one has expired, the remembered one has not
    store.create_session(admin_id=1)

    with session_factory() as db:
        assert len(db.scalars(select(AdminSession)).all()) == 2
