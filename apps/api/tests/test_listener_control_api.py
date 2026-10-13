"""S13-06: `POST /listener/reload` and `GET /listener/status` (panel side).

The API only writes a request into `listener_control` and reads the outcome
back; the listener that consumes it is exercised in `test_listener_reload.py`.
"""

import re
from collections.abc import Callable, Iterator
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from httpx import Response
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.listener_control import (
    claim_reload,
    config_fingerprint,
    load_active_config,
    record_applied,
    record_failed,
)
from app.main import app, get_db
from auth.hashing import hash_password
from auth.rate_limit import LoginRateLimiter
from auth.session import SessionStore
from models import Admin, ListenerControl, Recipient, Rule, Source
from models.base import Base

PASSWORD = "correct horse battery staple"
UTC_DATETIME = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$")


class Panel:
    def __init__(self, client: TestClient, factory: sessionmaker[Session], csrf: str) -> None:
        self.client = client
        self.factory = factory
        self.headers = {"x-csrf-token": csrf}

    def status(self) -> dict[str, object]:
        response = self.client.get("/listener/status")
        assert response.status_code == 200
        body: dict[str, object] = response.json()
        return body

    def reload(self) -> Response:
        return self.client.post("/listener/reload", headers=self.headers)

    def listener_applies_current_config(self, *, now: datetime | None = None) -> None:
        """What the real listener writes once it has loaded the database config."""
        with self.factory() as session:
            sources, rules, recipients = load_active_config(session)
            record_applied(
                session,
                sources_loaded=len(sources),
                rules_loaded=len(rules),
                recipients_loaded=len(recipients),
                config_hash=config_fingerprint(sources, rules, recipients),
                new_matches=3,
                scan_failures=0,
                now=now,
            )


@pytest.fixture
def panel() -> Iterator[Panel]:
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    with factory() as setup:
        setup.add(Admin(password_hash=hash_password(PASSWORD)))
        setup.commit()

    def override_get_db() -> Iterator[Session]:
        with factory() as session:
            yield session

    app.dependency_overrides[get_db] = override_get_db
    app.state.session_store = SessionStore()
    app.state.rate_limiter = LoginRateLimiter()
    with TestClient(app, base_url="https://testserver") as client:
        login = client.post("/auth/login", json={"password": PASSWORD})
        assert login.status_code == 200
        yield Panel(client, factory, login.json()["csrf_token"])
    app.dependency_overrides.clear()
    engine.dispose()


def test_reload_requires_a_session_and_a_csrf_token(panel: Panel) -> None:
    assert panel.client.post("/listener/reload").status_code == 403  # logged in, no CSRF
    wrong = panel.client.post("/listener/reload", headers={"x-csrf-token": "wrong"})
    assert wrong.status_code == 403

    panel.client.cookies.clear()
    assert panel.client.get("/listener/status").status_code == 401
    assert panel.client.post("/listener/reload", headers=panel.headers).status_code == 401

    with panel.factory() as session:
        assert session.get(ListenerControl, 1) is None  # a rejected call wrote nothing


def test_status_before_the_listener_ever_reported_is_idle_and_writes_nothing(
    panel: Panel,
) -> None:
    status = panel.status()

    assert status["state"] == "idle"
    assert status["listener_online"] is False
    assert status["has_unapplied_changes"] is False  # nothing configured, nothing to apply
    assert status["reload_applied_at"] is None
    with panel.factory() as session:
        assert session.get(ListenerControl, 1) is None


def test_reload_records_a_pending_request_and_answers_202_with_the_status(panel: Panel) -> None:
    response = panel.reload()

    assert response.status_code == 202
    body = response.json()
    assert body["state"] == "pending"
    assert UTC_DATETIME.match(body["reload_requested_at"])
    assert panel.status()["state"] == "pending"


def test_a_duplicate_request_while_pending_or_applying_is_ignored(panel: Panel) -> None:
    first = panel.reload().json()

    second = panel.reload()
    assert second.status_code == 202
    assert second.json()["reload_requested_at"] == first["reload_requested_at"]

    with panel.factory() as session:
        assert claim_reload(session)  # the listener starts applying
    third = panel.reload()
    assert third.status_code == 202
    assert third.json()["state"] == "applying"
    assert third.json()["reload_requested_at"] == first["reload_requested_at"]


def test_a_new_request_is_accepted_again_once_the_last_one_finished_or_failed(
    panel: Panel,
) -> None:
    panel.reload()
    with panel.factory() as session:
        assert claim_reload(session)
        record_failed(session, error_class="ConnectionError")
    assert panel.status()["state"] == "failed"
    assert panel.status()["error"] == "ConnectionError"

    assert panel.reload().json()["state"] == "pending"

    panel.listener_applies_current_config()
    assert panel.status()["state"] == "idle"
    assert panel.status()["error"] is None
    assert panel.reload().json()["state"] == "pending"


def test_status_datetimes_leave_the_api_as_utc_with_z(panel: Panel) -> None:
    panel.reload()
    panel.listener_applies_current_config(now=datetime.now(UTC))

    status = panel.status()

    for field in ("reload_requested_at", "reload_applied_at", "listener_seen_at"):
        value = status[field]
        assert isinstance(value, str) and UTC_DATETIME.match(value), f"{field}: {value!r}"
    assert status["listener_online"] is True
    assert status["new_matches"] == 3


def test_listener_online_goes_false_after_the_heartbeat_goes_stale(panel: Panel) -> None:
    panel.listener_applies_current_config(now=datetime.now(UTC) - timedelta(minutes=5))

    assert panel.status()["listener_online"] is False


def _seed_config(panel: Panel) -> tuple[int, int, int]:
    with panel.factory() as session:
        source = Source(name="Grupo", telegram_chat_id="-1001")
        rule = Rule(name="iPhone", include_terms="iphone")
        recipient = Recipient(name="Gabriel", telegram_chat_id="999", allowlisted=True)
        session.add_all([source, rule, recipient])
        session.commit()
        return source.id, rule.id, recipient.id


def test_unapplied_changes_follow_every_kind_of_change_but_not_renames(panel: Panel) -> None:
    source_id, rule_id, recipient_id = _seed_config(panel)
    assert panel.status()["has_unapplied_changes"] is True  # listener loaded nothing yet

    panel.listener_applies_current_config()
    assert panel.status()["has_unapplied_changes"] is False

    def change(edit: Callable[[Session], object]) -> None:
        with panel.factory() as session:
            edit(session)
            session.commit()

    # A rename changes nothing the listener does: no notice.
    change(lambda s: setattr(s.get(Rule, rule_id), "name", "Outro nome"))
    change(lambda s: setattr(s.get(Source, source_id), "name", "Outro grupo"))
    assert panel.status()["has_unapplied_changes"] is False

    # Editing terms, the ceiling, pausing, adding and removing all do.
    for edit in (
        lambda s: setattr(s.get(Rule, rule_id), "include_terms", "iphone,galaxy"),
        lambda s: setattr(s.get(Rule, rule_id), "max_price_cents", 300_000),
        lambda s: setattr(s.get(Source, source_id), "active", False),
        lambda s: setattr(s.get(Recipient, recipient_id), "allowlisted", False),
        lambda s: s.add(Rule(name="Nova", include_terms="ps5")),
        lambda s: s.delete(s.get(Rule, rule_id)),
    ):
        panel.listener_applies_current_config()
        assert panel.status()["has_unapplied_changes"] is False
        change(edit)
        assert panel.status()["has_unapplied_changes"] is True, edit


def test_a_change_made_while_applying_still_shows_as_unapplied(panel: Panel) -> None:
    """The listener stores the fingerprint of what *it loaded*, not of the
    database at the moment it finished."""
    _seed_config(panel)
    panel.reload()
    with panel.factory() as session:
        assert claim_reload(session)
        sources, rules, recipients = load_active_config(session)
        loaded_hash = config_fingerprint(sources, rules, recipients)

    with panel.factory() as session:  # the admin edits while the listener is busy
        session.add(Rule(name="Chegou tarde", include_terms="rtx"))
        session.commit()

    with panel.factory() as session:
        record_applied(
            session,
            sources_loaded=1,
            rules_loaded=1,
            recipients_loaded=1,
            config_hash=loaded_hash,
        )

    status = panel.status()
    assert status["state"] == "idle"
    assert status["has_unapplied_changes"] is True
