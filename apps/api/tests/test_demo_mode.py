"""S19-03: demo mode — read-only guard, startup guards, health payload, no network."""

import os
import shutil
import socket
import subprocess
import sys
from collections.abc import Callable, Iterator
from datetime import UTC, datetime
from pathlib import Path
from subprocess import CompletedProcess
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from app.config import get_settings
from app.demo_mode import (
    DEMO_PASSWORD,
    READ_ONLY_MESSAGE,
    DemoModeError,
    DemoReadOnlyMiddleware,
    check_database_mode,
)
from app.demo_seed import seed_demo_database
from app.main import app
from auth.hashing import hash_password
from models import Admin, Recipient, Rule, Source
from models.db import get_engine, get_sessionmaker


def _patch_session_factory(monkeypatch: pytest.MonkeyPatch, factory: Any) -> None:
    """Swap ``app.state.session_factory`` for one test.

    Starlette's ``State`` keeps values in ``_state``, not in ``__dict__``. Since
    pytest 9.2 ``monkeypatch.setattr`` records the old value from ``__dict__``, so its
    undo would delete the attribute and break every later test.
    """
    monkeypatch.setitem(app.state._state, "session_factory", factory)


# Real clock: the dry-run endpoint looks back from the actual current time.
NOW = datetime.now(UTC)
AlembicRunner = Callable[..., CompletedProcess[str]]


def _factory(tmp_path: Path, alembic_runner: AlembicRunner, name: str) -> sessionmaker[Session]:
    url = f"sqlite:///{tmp_path / name}"
    alembic_runner("upgrade", "head", database_url=url)
    return get_sessionmaker(get_engine(url))


@pytest.fixture(scope="module")
def demo_template(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """Seeded once per module; every test works on its own copy."""
    path = tmp_path_factory.mktemp("demo-template") / "demo.db"
    url = f"sqlite:///{path}"
    subprocess.run(
        [sys.executable, "-m", "alembic", "upgrade", "head"],
        cwd=Path(__file__).resolve().parents[1],
        env={**os.environ, "DATABASE_URL": url},
        check=True,
        capture_output=True,
    )
    seed_demo_database(get_sessionmaker(get_engine(url)), now=NOW)
    return path


@pytest.fixture
def demo_factory(demo_template: Path, tmp_path: Path) -> sessionmaker[Session]:
    path = tmp_path / "demo.db"
    shutil.copy(demo_template, path)
    return get_sessionmaker(get_engine(f"sqlite:///{path}"))


@pytest.fixture
def real_factory(tmp_path: Path, alembic_runner: AlembicRunner) -> sessionmaker[Session]:
    factory = _factory(tmp_path, alembic_runner, "real.db")
    with factory() as session:
        session.add(Source(name="Grupo real", telegram_chat_id="-1001234567890"))
        session.add(Admin(password_hash=hash_password("uma senha qualquer")))
        session.commit()
    return factory


def _set_env(monkeypatch: pytest.MonkeyPatch, **flags: str) -> None:
    for key in ("TELEYES_DEMO", "TELEYES_DEMO_READONLY", "TELEYES_DEMO_LIVE"):
        monkeypatch.delenv(key, raising=False)
    for key, value in flags.items():
        monkeypatch.setenv(key, value)
    get_settings.cache_clear()


@pytest.fixture(autouse=True)
def _reset_settings() -> Iterator[None]:
    yield
    get_settings.cache_clear()


@pytest.fixture
def demo_client(
    monkeypatch: pytest.MonkeyPatch, demo_factory: sessionmaker[Session]
) -> Iterator[TestClient]:
    _patch_session_factory(monkeypatch, demo_factory)
    # Live replay stays off: nothing should write behind the test's back.
    _set_env(monkeypatch, TELEYES_DEMO="1", TELEYES_DEMO_READONLY="1")
    with TestClient(app, base_url="https://testserver") as client:
        yield client


def _login(client: TestClient) -> str:
    response = client.post("/auth/login", json={"password": DEMO_PASSWORD})
    assert response.status_code == 200
    return str(response.json()["csrf_token"])


# --- read-only guard -----------------------------------------------------------


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("POST", "/rules"),
        ("PATCH", "/rules/1"),
        ("DELETE", "/rules/1"),
        ("POST", "/rules/1/pause"),
        ("DELETE", "/rules/1/matches"),
        ("POST", "/sources"),
        ("PATCH", "/sources/1"),
        ("DELETE", "/sources/1"),
        ("POST", "/recipients"),
        ("DELETE", "/recipients/1"),
        ("POST", "/listener/reload"),
        ("PUT", "/settings/feed"),
        ("PUT", "/digest"),
        ("POST", "/snoozes"),
        ("DELETE", "/snoozes/1"),
        ("POST", "/purchases"),
        ("PUT", "/purchases/1"),
        ("DELETE", "/purchases/1"),
        ("PATCH", "/matches/1"),
        ("POST", "/notifications/test"),
        ("POST", "/demo/messages"),
    ],
)
def test_every_mutating_verb_is_rejected_with_the_demo_message(
    demo_client: TestClient, method: str, path: str
) -> None:
    csrf = _login(demo_client)

    response = demo_client.request(method, path, json={}, headers={"X-CSRF-Token": csrf})

    assert response.status_code == 403
    assert response.json() == {"detail": READ_ONLY_MESSAGE}


def test_rejected_even_without_a_session(demo_client: TestClient) -> None:
    response = demo_client.post("/rules", json={})

    assert response.status_code == 403
    assert response.json()["detail"] == READ_ONLY_MESSAGE


def test_reads_login_logout_and_the_dry_run_are_allowed(demo_client: TestClient) -> None:
    assert demo_client.get("/health").status_code == 200
    csrf = _login(demo_client)
    assert demo_client.get("/rules").status_code == 200
    assert demo_client.get("/matches").status_code == 200
    dry_run = demo_client.post(
        "/rules/test", json={"include_terms": "ssd nvme exemplo"}, headers={"X-CSRF-Token": csrf}
    )
    assert dry_run.status_code == 200
    assert dry_run.json()["total_matched"] > 0
    logout = demo_client.post("/auth/logout", headers={"X-CSRF-Token": csrf})
    assert logout.status_code == 200


async def test_middleware_lets_sse_and_other_non_mutating_requests_through() -> None:
    reached: list[tuple[str, str]] = []

    async def downstream(scope: Any, receive: Any, send: Any) -> None:
        reached.append((scope["method"], scope["path"]))

    middleware = DemoReadOnlyMiddleware(downstream, is_active=lambda: True)

    async def receive() -> dict[str, Any]:
        return {"type": "http.request"}

    async def send(message: Any) -> None:
        raise AssertionError("non-mutating requests must not be answered by the guard")

    for method, path in (("GET", "/events"), ("HEAD", "/health"), ("OPTIONS", "/rules")):
        await middleware({"type": "http", "method": method, "path": path}, receive, send)
    # WebSocket/lifespan scopes are never touched either.
    await middleware({"type": "lifespan", "method": "POST", "path": "/rules"}, receive, send)

    assert len(reached) == 4


def test_the_guard_is_off_when_readonly_is_off(
    monkeypatch: pytest.MonkeyPatch, demo_factory: sessionmaker[Session]
) -> None:
    _patch_session_factory(monkeypatch, demo_factory)
    _set_env(monkeypatch, TELEYES_DEMO="1", TELEYES_DEMO_READONLY="0")

    with TestClient(app, base_url="https://testserver") as client:
        csrf = _login(client)
        created = client.post(
            "/rules",
            json={"name": "Regra de teste", "include_terms": "teclado exemplo"},
            headers={"X-CSRF-Token": csrf},
        )

    assert created.status_code == 201
    with demo_factory() as session:
        assert session.scalar(select(Rule).where(Rule.name == "Regra de teste")) is not None


def test_readonly_without_demo_does_nothing(
    monkeypatch: pytest.MonkeyPatch, real_factory: sessionmaker[Session]
) -> None:
    _patch_session_factory(monkeypatch, real_factory)
    _set_env(monkeypatch, TELEYES_DEMO_READONLY="1")

    with TestClient(app, base_url="https://testserver") as client:
        response = client.post("/auth/login", json={"password": "errada"})

    assert response.status_code == 401  # reached the app, not the demo guard


def test_the_session_cookie_is_not_secure_only_in_the_demo(
    monkeypatch: pytest.MonkeyPatch,
    demo_factory: sessionmaker[Session],
    real_factory: sessionmaker[Session],
) -> None:
    # Safari drops Secure cookies on plain http://localhost, where the demo runs.
    _patch_session_factory(monkeypatch, demo_factory)
    _set_env(monkeypatch, TELEYES_DEMO="1")
    with TestClient(app, base_url="https://testserver") as client:
        demo_cookie = client.post("/auth/login", json={"password": DEMO_PASSWORD}).headers[
            "set-cookie"
        ]

    _patch_session_factory(monkeypatch, real_factory)
    _set_env(monkeypatch)
    with TestClient(app, base_url="https://testserver") as client:
        with real_factory() as session:
            admin = session.scalar(select(Admin))
            assert admin is not None
            admin.password_hash = hash_password("senha real")
            session.commit()
        real_cookie = client.post("/auth/login", json={"password": "senha real"}).headers[
            "set-cookie"
        ]

    assert "Secure" not in demo_cookie and "HttpOnly" in demo_cookie
    assert "Secure" in real_cookie and "HttpOnly" in real_cookie


# --- health payload -------------------------------------------------------------


def test_health_reports_demo_listener_and_bot(demo_client: TestClient) -> None:
    body = demo_client.get("/health").json()

    assert body["demo"] is True
    assert body["telegram"] == {"configured": False, "state": "demo"}
    assert body["bot"]["state"] == "demo"


def test_health_is_not_demo_by_default(monkeypatch: pytest.MonkeyPatch) -> None:
    _set_env(monkeypatch)

    body = TestClient(app).get("/health").json()

    assert body["demo"] is False
    assert body["telegram"]["state"] == "not_configured"


def test_blank_flags_are_off(monkeypatch: pytest.MonkeyPatch) -> None:
    _set_env(monkeypatch, TELEYES_DEMO="", TELEYES_DEMO_READONLY=" ")

    settings = get_settings()

    assert settings.teleyes_demo is False and settings.teleyes_demo_readonly is False


# --- startup guards ---------------------------------------------------------------


def test_demo_mode_accepts_a_demo_database(demo_factory: sessionmaker[Session]) -> None:
    with demo_factory() as session:
        check_database_mode(session, demo=True)


def test_demo_mode_accepts_an_empty_database(tmp_path: Path, alembic_runner: AlembicRunner) -> None:
    with _factory(tmp_path, alembic_runner, "empty.db")() as session:
        check_database_mode(session, demo=True)
        check_database_mode(session, demo=False)


def test_demo_mode_refuses_a_real_database(real_factory: sessionmaker[Session]) -> None:
    with real_factory() as session, pytest.raises(DemoModeError):
        check_database_mode(session, demo=True)


def test_demo_mode_refuses_a_mixed_database(demo_factory: sessionmaker[Session]) -> None:
    with demo_factory() as session:
        session.add(Recipient(name="Alguém", telegram_chat_id="123456789", allowlisted=True))
        session.commit()
        with pytest.raises(DemoModeError):
            check_database_mode(session, demo=True)


def test_demo_mode_refuses_an_admin_that_is_not_the_demo_one(
    tmp_path: Path, alembic_runner: AlembicRunner
) -> None:
    factory = _factory(tmp_path, alembic_runner, "admin-only.db")
    with factory() as session:
        session.add(Admin(password_hash=hash_password("senha de verdade")))
        session.commit()
        with pytest.raises(DemoModeError):
            check_database_mode(session, demo=True)


def test_normal_mode_refuses_a_demo_database(demo_factory: sessionmaker[Session]) -> None:
    with demo_factory() as session, pytest.raises(DemoModeError):
        check_database_mode(session, demo=False)


def test_a_database_without_tables_does_not_block_startup(tmp_path: Path) -> None:
    session_factory = get_sessionmaker(get_engine(f"sqlite:///{tmp_path / 'blank.db'}"))
    with session_factory() as session:
        check_database_mode(session, demo=True)
        check_database_mode(session, demo=False)


def test_the_app_refuses_to_start_in_demo_mode_on_a_real_database(
    monkeypatch: pytest.MonkeyPatch, real_factory: sessionmaker[Session]
) -> None:
    _patch_session_factory(monkeypatch, real_factory)
    _set_env(monkeypatch, TELEYES_DEMO="1")

    with pytest.raises(DemoModeError), TestClient(app):
        pass


def test_the_app_refuses_to_start_in_normal_mode_on_a_demo_database(
    monkeypatch: pytest.MonkeyPatch, demo_factory: sessionmaker[Session]
) -> None:
    _patch_session_factory(monkeypatch, demo_factory)
    _set_env(monkeypatch)

    with pytest.raises(DemoModeError), TestClient(app):
        pass


def test_the_demo_password_does_not_log_in_a_normal_database(
    monkeypatch: pytest.MonkeyPatch, real_factory: sessionmaker[Session]
) -> None:
    _patch_session_factory(monkeypatch, real_factory)
    _set_env(monkeypatch)

    with TestClient(app, base_url="https://testserver") as client:
        response = client.post("/auth/login", json={"password": DEMO_PASSWORD})

    assert response.status_code == 401


# --- notifier ---------------------------------------------------------------------


def test_the_test_notification_is_a_no_op_that_never_touches_the_network(
    monkeypatch: pytest.MonkeyPatch, demo_factory: sessionmaker[Session]
) -> None:
    def no_network(*args: object, **kwargs: object) -> None:
        raise AssertionError("demo mode must not open a network connection")

    _patch_session_factory(monkeypatch, demo_factory)
    _set_env(monkeypatch, TELEYES_DEMO="1", TELEYES_DEMO_READONLY="0")
    with TestClient(app, base_url="https://testserver") as client:
        csrf = _login(client)
        monkeypatch.setattr(socket.socket, "connect", no_network)
        response = client.post(
            "/notifications/test",
            json={"chat_id": "demo:recipient-1"},
            headers={"X-CSRF-Token": csrf},
        )

    assert response.status_code == 200
    assert response.json()["delivered"] is True


def test_create_admin_refuses_the_public_demo_password(monkeypatch: pytest.MonkeyPatch) -> None:
    import importlib.util

    spec = importlib.util.spec_from_file_location(
        "create_admin_script", Path(__file__).resolve().parents[3] / "scripts" / "create_admin.py"
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    answers = iter([DEMO_PASSWORD])
    monkeypatch.setattr(module.getpass, "getpass", lambda _prompt: next(answers))

    with pytest.raises(SystemExit):
        module.main()
