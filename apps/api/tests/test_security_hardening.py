"""S23-01: login throttling, request size ceiling and the read-only demo, end to end."""

import re

import pytest
from tests.match_api_support import PASSWORD, ApiContext, api  # noqa: F401  (fixture)
from tests.setup_support import FakeClock

from app.body_limit import MAX_BODY_BYTES
from app.config import Settings
from app.demo_mode import READ_ONLY_EXEMPT_PATHS, READ_ONLY_MESSAGE
from app.main import app
from auth.rate_limit import LoginRateLimiter

# --- login throttling ---


def _fresh_client(api: ApiContext):  # type: ignore[no-untyped-def]  # noqa: F811
    api.client.cookies.clear()
    return api.client


def test_five_wrong_passwords_lock_the_login_with_a_portuguese_message(api: ApiContext) -> None:  # noqa: F811
    clock = FakeClock()
    app.state.rate_limiter = LoginRateLimiter(clock=clock)
    client = _fresh_client(api)

    for _ in range(5):
        wrong = client.post("/auth/login", json={"password": "nope"})
        assert wrong.status_code == 401

    locked = client.post("/auth/login", json={"password": PASSWORD})

    assert locked.status_code == 429
    assert locked.json()["detail"].startswith("Muitas tentativas de entrada.")
    assert 55 <= int(locked.headers["retry-after"]) <= 61
    assert "session" not in locked.headers.get("set-cookie", "")


def test_the_lock_lifts_after_the_wait_and_doubles_when_it_repeats(api: ApiContext) -> None:  # noqa: F811
    clock = FakeClock()
    app.state.rate_limiter = LoginRateLimiter(clock=clock)
    client = _fresh_client(api)

    for _ in range(5):
        client.post("/auth/login", json={"password": "nope"})
    first = client.post("/auth/login", json={"password": PASSWORD})
    clock.advance(62)
    for _ in range(5):
        client.post("/auth/login", json={"password": "nope"})
    second = client.post("/auth/login", json={"password": PASSWORD})

    assert first.status_code == second.status_code == 429
    assert int(second.headers["retry-after"]) > 100

    clock.advance(130)
    ok = client.post("/auth/login", json={"password": PASSWORD})
    assert ok.status_code == 200


def test_failures_spread_over_more_than_the_window_do_not_lock(api: ApiContext) -> None:  # noqa: F811
    clock = FakeClock()
    app.state.rate_limiter = LoginRateLimiter(clock=clock)
    client = _fresh_client(api)

    for _ in range(8):
        assert client.post("/auth/login", json={"password": "nope"}).status_code == 401
        clock.advance(100)  # 5 failures never fall inside one 300 s window


def test_a_wrong_password_never_says_whether_an_admin_exists(api: ApiContext) -> None:  # noqa: F811
    client = _fresh_client(api)
    wrong = client.post("/auth/login", json={"password": "nope"})

    from sqlalchemy import delete

    from models import Admin

    with api.session_factory() as db:
        db.execute(delete(Admin))
        db.commit()
    missing = client.post("/auth/login", json={"password": "nope"})

    assert (wrong.status_code, wrong.json()) == (missing.status_code, missing.json())


def test_a_giant_password_is_refused_before_hashing(api: ApiContext) -> None:  # noqa: F811
    client = _fresh_client(api)

    response = client.post("/auth/login", json={"password": "x" * 5000})

    assert response.status_code == 422


# --- cookie ---


def test_the_session_cookie_is_httponly_secure_and_samesite_strict(api: ApiContext) -> None:  # noqa: F811
    client = _fresh_client(api)

    response = client.post("/auth/login", json={"password": PASSWORD})

    cookie = response.headers["set-cookie"].lower()
    assert "httponly" in cookie and "secure" in cookie and "samesite=strict" in cookie
    assert "path=/" in cookie


# --- request size ---


def test_an_oversized_declared_body_is_refused_with_413(api: ApiContext) -> None:  # noqa: F811
    response = api.client.post(
        "/rules",
        content=b"{" + b" " * (MAX_BODY_BYTES + 10) + b"}",
        headers={"content-type": "application/json"},
    )

    assert response.status_code == 413
    assert response.json() == {"detail": "Requisição grande demais."}


def test_an_oversized_streamed_body_is_refused_too(api: ApiContext) -> None:  # noqa: F811
    def chunks():  # type: ignore[no-untyped-def]
        for _ in range(MAX_BODY_BYTES // 1024 + 2):
            yield b" " * 1024

    response = api.client.post(
        "/rules", content=chunks(), headers={"content-type": "application/json"}
    )

    assert response.status_code == 413


def test_a_normal_body_still_goes_through(api: ApiContext) -> None:  # noqa: F811
    me = api.client.get("/auth/me").json()

    response = api.client.post(
        "/rules",
        json={"name": "Teste", "include_terms": "ssd"},
        headers={"x-csrf-token": me["csrf_token"]},
    )

    assert response.status_code in (200, 201)


# --- demo mode ---


def _mutating_paths() -> list[tuple[str, str]]:
    found = []
    for path, operations in app.openapi()["paths"].items():
        for method in operations:
            if method.upper() in {"POST", "PUT", "PATCH", "DELETE"}:
                found.append((method.upper(), re.sub(r"\{[^}]+\}", "1", path)))
    return found


# S23-09: READ_ONLY_EXEMPT_PATHS is the explicit allowlist (login/logout and the
# `/rules/test` dry run, which never writes: proven in test_demo_mode.py). Every
# other mutating route must answer 403.
@pytest.mark.parametrize(
    ("method", "path"),
    [(m, p) for m, p in _mutating_paths() if p.rstrip("/") not in READ_ONLY_EXEMPT_PATHS],
)
def test_the_read_only_demo_blocks_every_state_changing_route(
    api: ApiContext,  # noqa: F811
    monkeypatch: pytest.MonkeyPatch,
    method: str,
    path: str,
) -> None:
    demo = Settings(teleyes_demo=True, teleyes_demo_readonly=True)
    monkeypatch.setattr("app.main.get_settings", lambda: demo)
    me = api.client.get("/auth/me").json()

    response = api.client.request(method, path, json={}, headers={"x-csrf-token": me["csrf_token"]})

    assert response.status_code == 403, f"{method} {path} is writable in the read-only demo"
    assert response.json() == {"detail": READ_ONLY_MESSAGE}
