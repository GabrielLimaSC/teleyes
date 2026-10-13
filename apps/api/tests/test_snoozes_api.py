"""S14-03 (F3): `POST/GET /snoozes` and `DELETE /snoozes/{id}` ("Reativar").

The clock is pinned through the `utc_now` dependency, same as every other
S14 test.
"""

import itertools
import time
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.main import app
from app.utc import utc_now
from auth.hashing import hash_password
from auth.rate_limit import LoginRateLimiter
from auth.session import SessionStore
from models import Admin, Match, Rule, Snooze, Source
from models.base import Base
from packages.telegram.adapter import TelegramAdapter
from packages.telegram.fakes import FakeTelegramClient

PASSWORD = "correct horse battery staple"
NOW = datetime(2026, 9, 23, 15, 0, tzinfo=UTC)
PALIT = "Placa de Vídeo Palit RTX 5070 Ti 16GB"
PALIT_KEY = "palit-rtx-5070-ti"


@dataclass
class ApiContext:
    client: TestClient
    session_factory: sessionmaker[Session]
    ids: dict[str, int] = field(default_factory=dict)


async def _no_sleep(delay: float) -> None:
    return None


@pytest.fixture
def api() -> Iterator[ApiContext]:
    engine: Engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    test_sessionmaker = sessionmaker(bind=engine, expire_on_commit=False)
    with test_sessionmaker() as setup_session:
        setup_session.add(Admin(password_hash=hash_password(PASSWORD)))
        source = Source(name="Grupo A", telegram_chat_id="-1001")
        rule = Rule(name="Placas", include_terms="rtx")
        other_rule = Rule(name="Notebooks", include_terms="notebook")
        setup_session.add_all([source, rule, other_rule])
        setup_session.commit()
        ids = {"source": source.id, "rule": rule.id, "other_rule": other_rule.id}

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
            api_id=None, api_hash=None, client=FakeTelegramClient(), sleep=_no_sleep
        )
        app.state.bot_configured = False
        app.state.notification_test_ids = itertools.count(start=-1, step=-1)
        app.dependency_overrides.clear()
        app.dependency_overrides[utc_now] = lambda: NOW
        with TestClient(app, base_url="https://testserver") as client:
            response = client.post("/auth/login", json={"password": PASSWORD})
            assert response.status_code == 200
            yield ApiContext(client=client, session_factory=test_sessionmaker, ids=ids)
    finally:
        app.dependency_overrides.clear()
        app.dependency_overrides.update(previous_overrides)
        for name, value in previous_state.items():
            setattr(app.state, name, value)
        engine.dispose()


def _login_csrf(api: ApiContext) -> str:
    response = api.client.post("/auth/login", json={"password": PASSWORD})
    assert response.status_code == 200
    return str(response.json()["csrf_token"])


def _add_match(
    api: ApiContext,
    title: str,
    *,
    ago: timedelta,
    rule_id: int | None = None,
    product_key: str | None = PALIT_KEY,
) -> int:
    text = f"🔥 {title}\n\n💵 R$ 5.749,00 no pix\nhttps://loja.example/p"
    with api.session_factory() as session:
        match = Match(
            source_id=api.ids["source"],
            rule_id=rule_id if rule_id is not None else api.ids["rule"],
            message_text=text,
            matched_at=NOW - ago,
            product_key=product_key,
        )
        session.add(match)
        session.commit()
        return match.id


def test_snoozes_require_a_session(api: ApiContext) -> None:
    api.client.post("/auth/logout")
    api.client.cookies.clear()

    assert api.client.get("/snoozes").status_code == 401
    assert api.client.post("/snoozes", json={"scope": "rule"}).status_code == 401
    assert api.client.delete("/snoozes/1").status_code == 401


def test_create_requires_csrf(api: ApiContext) -> None:
    response = api.client.post(
        "/snoozes", json={"scope": "rule", "rule_id": api.ids["rule"], "days": 7}
    )
    assert response.status_code == 403


def test_create_and_list_a_rule_snooze_with_its_label(api: ApiContext) -> None:
    csrf = _login_csrf(api)

    created = api.client.post(
        "/snoozes",
        json={"scope": "rule", "rule_id": api.ids["rule"], "days": 7},
        headers={"x-csrf-token": csrf},
    )
    assert created.status_code == 201
    body = created.json()
    assert body["scope"] == "rule"
    assert body["rule_id"] == api.ids["rule"]
    assert body["product_key"] is None
    assert body["label"] == "Placas"
    assert body["until"] == "2026-09-30T15:00:00Z"

    listed = api.client.get("/snoozes").json()
    assert len(listed) == 1
    assert listed[0]["id"] == body["id"]
    assert listed[0]["label"] == "Placas"


def test_create_a_product_snooze_uses_the_most_recent_posting_title(api: ApiContext) -> None:
    _add_match(api, PALIT, ago=timedelta(days=5))
    _add_match(api, PALIT.upper(), ago=timedelta(hours=1))  # most recent, different casing
    csrf = _login_csrf(api)

    created = api.client.post(
        "/snoozes",
        json={"scope": "product", "product_key": PALIT_KEY, "days": 3},
        headers={"x-csrf-token": csrf},
    )
    assert created.status_code == 201
    assert created.json()["label"] == PALIT.upper()


def test_create_with_an_absolute_until(api: ApiContext) -> None:
    csrf = _login_csrf(api)

    created = api.client.post(
        "/snoozes",
        json={
            "scope": "rule",
            "rule_id": api.ids["rule"],
            "until": "2026-10-01T00:00:00Z",
        },
        headers={"x-csrf-token": csrf},
    )
    assert created.status_code == 201
    assert created.json()["until"] == "2026-10-01T00:00:00Z"


@pytest.mark.parametrize(
    "payload",
    [
        {"scope": "rule", "days": 7},  # missing rule_id
        {"scope": "rule", "rule_id": 1, "product_key": "x", "days": 7},  # both targets
        {"scope": "product", "days": 7},  # missing product_key
        {"scope": "product", "product_key": "x", "rule_id": 1, "days": 7},  # both targets
        {"scope": "rule", "rule_id": 1},  # neither days nor until
        {
            "scope": "rule",
            "rule_id": 1,
            "days": 1,
            "until": "2026-10-01T00:00:00Z",
        },  # both days and until
        {"scope": "rule", "rule_id": 1, "days": 0},
        {"scope": "rule", "rule_id": 1, "days": -1},
        {"scope": "rule", "rule_id": 1, "until": "2020-01-01T00:00:00Z"},  # in the past
    ],
)
def test_create_rejects_inconsistent_payloads(
    api: ApiContext, payload: dict[str, object]
) -> None:
    csrf = _login_csrf(api)

    response = api.client.post("/snoozes", json=payload, headers={"x-csrf-token": csrf})

    assert response.status_code == 422


def test_create_with_an_unknown_rule_is_404(api: ApiContext) -> None:
    csrf = _login_csrf(api)

    response = api.client.post(
        "/snoozes",
        json={"scope": "rule", "rule_id": 999_999, "days": 7},
        headers={"x-csrf-token": csrf},
    )

    assert response.status_code == 404


def test_a_new_snooze_replaces_the_previous_one_for_the_same_target(api: ApiContext) -> None:
    csrf = _login_csrf(api)
    first = api.client.post(
        "/snoozes",
        json={"scope": "rule", "rule_id": api.ids["rule"], "days": 1},
        headers={"x-csrf-token": csrf},
    ).json()

    second = api.client.post(
        "/snoozes",
        json={"scope": "rule", "rule_id": api.ids["rule"], "days": 30},
        headers={"x-csrf-token": csrf},
    ).json()

    listed = api.client.get("/snoozes").json()
    assert len(listed) == 1
    assert listed[0]["until"] == second["until"]
    assert listed[0]["until"] != first["until"]


def test_list_only_returns_active_snoozes(api: ApiContext) -> None:
    with api.session_factory() as session:
        session.add_all(
            [
                Snooze(scope="rule", rule_id=api.ids["rule"], until=NOW + timedelta(days=1)),
                Snooze(
                    scope="rule", rule_id=api.ids["other_rule"], until=NOW - timedelta(minutes=1)
                ),
            ]
        )
        session.commit()

    listed = api.client.get("/snoozes").json()

    assert [item["rule_id"] for item in listed] == [api.ids["rule"]]


def test_delete_reactivates(api: ApiContext) -> None:
    csrf = _login_csrf(api)
    created = api.client.post(
        "/snoozes",
        json={"scope": "rule", "rule_id": api.ids["rule"], "days": 7},
        headers={"x-csrf-token": csrf},
    ).json()

    deleted = api.client.delete(f"/snoozes/{created['id']}", headers={"x-csrf-token": csrf})
    assert deleted.status_code == 204

    assert api.client.get("/snoozes").json() == []


def test_delete_requires_csrf(api: ApiContext) -> None:
    csrf = _login_csrf(api)
    created = api.client.post(
        "/snoozes",
        json={"scope": "rule", "rule_id": api.ids["rule"], "days": 7},
        headers={"x-csrf-token": csrf},
    ).json()

    response = api.client.delete(f"/snoozes/{created['id']}")

    assert response.status_code == 403


def test_delete_unknown_is_404(api: ApiContext) -> None:
    csrf = _login_csrf(api)

    response = api.client.delete("/snoozes/999999", headers={"x-csrf-token": csrf})

    assert response.status_code == 404


def test_feed_flags_a_match_as_snoozed_by_rule_or_by_product(api: ApiContext) -> None:
    rule_match = _add_match(api, PALIT, ago=timedelta(hours=1))
    other_match = _add_match(
        api,
        "Notebook Dell",
        ago=timedelta(hours=2),
        rule_id=api.ids["other_rule"],
        product_key=None,
    )
    with api.session_factory() as session:
        session.add(Snooze(scope="rule", rule_id=api.ids["rule"], until=NOW + timedelta(days=1)))
        session.commit()

    items = {item["id"]: item for item in api.client.get("/matches").json()}

    assert items[rule_match]["snoozed"] is True
    assert items[other_match]["snoozed"] is False


def test_feed_flags_a_match_as_snoozed_by_product_even_across_rules(api: ApiContext) -> None:
    same_product_other_rule = _add_match(
        api, PALIT, ago=timedelta(hours=1), rule_id=api.ids["other_rule"]
    )
    with api.session_factory() as session:
        session.add(Snooze(scope="product", product_key=PALIT_KEY, until=NOW + timedelta(days=1)))
        session.commit()

    items = {item["id"]: item for item in api.client.get("/matches").json()}

    assert items[same_product_other_rule]["snoozed"] is True


def test_an_expired_snooze_does_not_flag_the_feed(api: ApiContext) -> None:
    match_id = _add_match(api, PALIT, ago=timedelta(hours=1))
    with api.session_factory() as session:
        session.add(Snooze(scope="rule", rule_id=api.ids["rule"], until=NOW - timedelta(minutes=1)))
        session.commit()

    items = {item["id"]: item for item in api.client.get("/matches").json()}

    assert items[match_id]["snoozed"] is False


def test_rules_expose_snoozed_until_only_while_active(api: ApiContext) -> None:
    with api.session_factory() as session:
        session.add_all(
            [
                Snooze(scope="rule", rule_id=api.ids["rule"], until=NOW + timedelta(days=1)),
                Snooze(
                    scope="rule", rule_id=api.ids["other_rule"], until=NOW - timedelta(minutes=1)
                ),
            ]
        )
        session.commit()

    rules = {rule["id"]: rule for rule in api.client.get("/rules").json()}

    assert rules[api.ids["rule"]]["snoozed_until"] == "2026-09-24T15:00:00Z"
    assert rules[api.ids["other_rule"]]["snoozed_until"] is None
