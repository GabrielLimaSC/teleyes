"""S14-05 (F5): `GET /matches` read-time duplicate grouping — distinct
sources posting the same `product_key` at the same price within
`GROUPING_WINDOW` collapse into one card (`seen_count`, `sources`,
`grouped_match_ids`, `group_key`). Controlled by the "Agrupar duplicatas"
toggle (`GET/PUT /settings/feed`). No `Match` row is ever deleted or
merged — only this read-time response changes shape.

Every seeded match here uses its own dedicated `Rule` (one per source) so
the older, unrelated S7-11 rule+price grouping (`_apply_display_grouping`)
never folds them first and hides the very duplicates this suite is
checking — this feature's whole point is grouping *across* different rules
by `product_key` instead.
"""

import itertools
import time
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.main import app
from app.pipeline import GROUPING_WINDOW
from auth.hashing import hash_password
from auth.rate_limit import LoginRateLimiter
from auth.session import SessionStore
from models import Admin, Match, Rule, Source
from models.base import Base
from packages.telegram.adapter import TelegramAdapter
from packages.telegram.fakes import FakeTelegramClient

PASSWORD = "correct horse battery staple"
NOW = datetime(2026, 9, 24, 12, 0, tzinfo=UTC)
PRODUCT_KEY = "palit-rtx-5070-ti"


@dataclass
class ApiContext:
    client: TestClient
    session_factory: sessionmaker[Session]
    source_ids: list[int]
    rule_ids: list[int]


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
        sources = [Source(name=f"Grupo {i}", telegram_chat_id=f"-100{i}") for i in range(1, 4)]
        # One rule per source — see the module docstring for why.
        rules = [Rule(name=f"Placas {i}", include_terms="rtx") for i in range(1, 4)]
        setup_session.add_all([*sources, *rules])
        setup_session.commit()
        source_ids = [source.id for source in sources]
        rule_ids = [rule.id for rule in rules]

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
        with TestClient(app, base_url="https://testserver") as client:
            response = client.post("/auth/login", json={"password": PASSWORD})
            assert response.status_code == 200
            yield ApiContext(
                client=client,
                session_factory=test_sessionmaker,
                source_ids=source_ids,
                rule_ids=rule_ids,
            )
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
    *,
    source_index: int,
    price_cents: int,
    minutes_offset: float,
    telegram_message_id: int,
    product_key: str | None = PRODUCT_KEY,
) -> int:
    with api.session_factory() as session:
        match = Match(
            source_id=api.source_ids[source_index],
            rule_id=api.rule_ids[source_index],
            message_text="RTX 5070 Ti por R$ 4.000,00",
            price_cents=price_cents,
            product_key=product_key,
            matched_at=NOW + timedelta(minutes=minutes_offset),
            telegram_message_id=telegram_message_id,
        )
        session.add(match)
        session.commit()
        return match.id


def test_feed_settings_default_on(api: ApiContext) -> None:
    response = api.client.get("/settings/feed")
    assert response.status_code == 200
    assert response.json() == {"group_duplicates": True}


def test_three_sources_same_product_and_price_in_window_group_into_one_card(
    api: ApiContext,
) -> None:
    a = _add_match(
        api, source_index=0, price_cents=400_000, minutes_offset=0, telegram_message_id=1
    )
    b = _add_match(
        api, source_index=1, price_cents=400_000, minutes_offset=5, telegram_message_id=2
    )
    c = _add_match(
        api, source_index=2, price_cents=400_000, minutes_offset=10, telegram_message_id=3
    )

    response = api.client.get("/matches")
    assert response.status_code == 200
    payload = response.json()

    # Only the earliest survives as its own card — the representative.
    assert {item["id"] for item in payload} == {a}
    representative = payload[0]
    assert representative["seen_count"] == 3
    assert len(representative["sources"]) == 3
    assert {source["id"] for source in representative["sources"]} == set(api.source_ids)
    assert set(representative["grouped_match_ids"]) == {a, b, c}
    assert representative["group_key"] is not None


def test_different_price_in_the_same_window_never_groups(api: ApiContext) -> None:
    a = _add_match(
        api, source_index=0, price_cents=400_000, minutes_offset=0, telegram_message_id=1
    )
    b = _add_match(
        api, source_index=1, price_cents=420_000, minutes_offset=5, telegram_message_id=2
    )

    response = api.client.get("/matches")
    by_id = {item["id"]: item for item in response.json()}

    assert set(by_id) == {a, b}
    assert by_id[a]["seen_count"] == 1
    assert by_id[b]["seen_count"] == 1
    assert by_id[a]["grouped_match_ids"] == [a]
    assert by_id[a]["sources"] == []


def test_outside_the_grouping_window_never_groups(api: ApiContext) -> None:
    past_window_minutes = (GROUPING_WINDOW + timedelta(minutes=1)).total_seconds() / 60
    a = _add_match(
        api, source_index=0, price_cents=400_000, minutes_offset=0, telegram_message_id=1
    )
    b = _add_match(
        api,
        source_index=1,
        price_cents=400_000,
        minutes_offset=past_window_minutes,
        telegram_message_id=2,
    )

    response = api.client.get("/matches")
    by_id = {item["id"]: item for item in response.json()}

    assert set(by_id) == {a, b}
    assert by_id[a]["seen_count"] == 1
    assert by_id[b]["seen_count"] == 1


def test_toggle_off_lists_every_match_as_its_own_card(api: ApiContext) -> None:
    a = _add_match(
        api, source_index=0, price_cents=400_000, minutes_offset=0, telegram_message_id=1
    )
    b = _add_match(
        api, source_index=1, price_cents=400_000, minutes_offset=5, telegram_message_id=2
    )
    csrf = _login_csrf(api)

    put_response = api.client.put(
        "/settings/feed", json={"group_duplicates": False}, headers={"x-csrf-token": csrf}
    )
    assert put_response.status_code == 200
    assert put_response.json() == {"group_duplicates": False}
    assert api.client.get("/settings/feed").json() == {"group_duplicates": False}

    response = api.client.get("/matches")
    by_id = {item["id"]: item for item in response.json()}

    assert set(by_id) == {a, b}
    assert by_id[a]["seen_count"] == 1
    assert by_id[b]["seen_count"] == 1
    assert by_id[a]["sources"] == []
    assert by_id[b]["sources"] == []


def test_a_message_caught_by_two_rules_is_one_sighting_not_a_duplicate_group(
    api: ApiContext,
) -> None:
    """Same Telegram message, two rules: `posting_identity` must dedupe it
    before counting, so this never inflates `seen_count`/creates a group.
    """
    with api.session_factory() as session:
        first = Match(
            source_id=api.source_ids[0],
            rule_id=api.rule_ids[0],
            message_text="RTX 5070 Ti por R$ 4.000,00",
            price_cents=400_000,
            product_key=PRODUCT_KEY,
            matched_at=NOW,
            telegram_message_id=42,
        )
        second = Match(
            source_id=api.source_ids[0],
            rule_id=api.rule_ids[1],
            message_text="RTX 5070 Ti por R$ 4.000,00",
            price_cents=400_000,
            product_key=PRODUCT_KEY,
            matched_at=NOW,
            telegram_message_id=42,
        )
        session.add_all([first, second])
        session.commit()
        first_id, second_id = first.id, second.id

    response = api.client.get("/matches")
    by_id = {item["id"]: item for item in response.json()}

    assert set(by_id) == {first_id, second_id}
    assert by_id[first_id]["seen_count"] == 1
    assert by_id[second_id]["seen_count"] == 1
