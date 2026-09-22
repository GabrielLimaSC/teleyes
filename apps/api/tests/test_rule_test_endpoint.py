"""S13-07: `POST /rules/test` — dry-run of a not-yet-saved rule form against
real history. Isolation from the real pipeline (no `Match`/`Delivery`
created, no cursor advanced, no `BotNotifier` called) and "the preview
changes when the form changes, without saving" are the two `done_when`
guarantees; everything else here backs those up.
"""

from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.main import app, get_db
from app.pipeline import HISTORICAL_WINDOW
from auth.hashing import hash_password
from auth.rate_limit import LoginRateLimiter
from auth.session import SessionStore
from models import Admin, Delivery, Match, Source
from models.base import Base

PASSWORD = "correct horse battery staple"


@pytest.fixture
def sessionmaker_() -> Iterator[sessionmaker[Session]]:
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

    yield test_sessionmaker


@pytest.fixture
def client(sessionmaker_: sessionmaker[Session]) -> Iterator[TestClient]:
    def override_get_db() -> Iterator[Session]:
        with sessionmaker_() as session:
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


def _test_rule(client: TestClient, csrf: str, **payload: object) -> dict[str, Any]:
    response = client.post("/rules/test", json=payload, headers={"x-csrf-token": csrf})
    assert response.status_code == 200
    return response.json()


def _seed_match(
    session: Session,
    *,
    source: Source,
    text: str,
    telegram_message_id: int | None,
    price_cents: int | None = None,
    matched_at: datetime | None = None,
    rule_id: int = 1,
) -> Match:
    match = Match(
        source_id=source.id,
        rule_id=rule_id,
        telegram_message_id=telegram_message_id,
        message_text=text,
        price_cents=price_cents,
        matched_at=matched_at or datetime.now(UTC),
    )
    session.add(match)
    session.flush()
    return match


def test_previews_matching_messages_from_history_without_saving(
    client: TestClient, sessionmaker_: sessionmaker[Session]
) -> None:
    csrf = login(client)
    with sessionmaker_() as session:
        source = Source(name="Grupo Teste", telegram_chat_id="-100999")
        session.add(source)
        session.flush()
        _seed_match(
            session, source=source, text="Promoção iPhone 15 por R$ 3.899", telegram_message_id=1
        )
        _seed_match(
            session, source=source, text="Samsung Galaxy em promoção", telegram_message_id=2
        )
        session.commit()

    body = _test_rule(client, csrf, include_terms="iphone")

    assert body["total_matched"] == 1
    assert len(body["messages"]) == 1
    hit = body["messages"][0]
    assert hit["message_text"] == "Promoção iPhone 15 por R$ 3.899"
    assert hit["source_name"] == "Grupo Teste"
    assert hit["matched_term"] == "iphone"
    assert hit["price_cents"] == 389900


def test_preview_changes_when_the_form_terms_change_without_saving(
    client: TestClient, sessionmaker_: sessionmaker[Session]
) -> None:
    """The core `done_when`: editing the form and clicking Testar again (a
    second, independent call, never a saved rule) reflects the new terms.
    """
    csrf = login(client)
    with sessionmaker_() as session:
        source = Source(name="Grupo Teste", telegram_chat_id="-100999")
        session.add(source)
        session.flush()
        _seed_match(session, source=source, text="Notebook Gamer RTX 4060", telegram_message_id=1)
        _seed_match(
            session, source=source, text="Monitor 27 polegadas 165Hz", telegram_message_id=2
        )
        session.commit()

    first = _test_rule(client, csrf, include_terms="notebook")
    assert [m["message_text"] for m in first["messages"]] == ["Notebook Gamer RTX 4060"]

    second = _test_rule(client, csrf, include_terms="monitor")
    assert [m["message_text"] for m in second["messages"]] == ["Monitor 27 polegadas 165Hz"]


def test_never_persists_a_match_or_delivery_even_called_repeatedly(
    client: TestClient, sessionmaker_: sessionmaker[Session]
) -> None:
    csrf = login(client)
    with sessionmaker_() as session:
        source = Source(name="Grupo Teste", telegram_chat_id="-100999")
        session.add(source)
        session.flush()
        _seed_match(session, source=source, text="iPhone 15 por R$ 3.899", telegram_message_id=1)
        session.commit()

    with sessionmaker_() as session:
        matches_before = session.scalar(select(func.count()).select_from(Match))
        deliveries_before = session.scalar(select(func.count()).select_from(Delivery))

    for _ in range(10):
        body = _test_rule(client, csrf, include_terms="iphone")
        assert body["total_matched"] == 1

    with sessionmaker_() as session:
        matches_after = session.scalar(select(func.count()).select_from(Match))
        deliveries_after = session.scalar(select(func.count()).select_from(Delivery))

    assert matches_after == matches_before
    assert deliveries_after == deliveries_before


def test_excludes_messages_older_than_the_historical_window(
    client: TestClient, sessionmaker_: sessionmaker[Session]
) -> None:
    csrf = login(client)
    now = datetime.now(UTC)
    with sessionmaker_() as session:
        source = Source(name="Grupo Teste", telegram_chat_id="-100999")
        session.add(source)
        session.flush()
        _seed_match(
            session,
            source=source,
            text="iphone dentro da janela",
            telegram_message_id=1,
            matched_at=now - HISTORICAL_WINDOW + timedelta(hours=1),
        )
        _seed_match(
            session,
            source=source,
            text="iphone fora da janela",
            telegram_message_id=2,
            matched_at=now - HISTORICAL_WINDOW - timedelta(hours=1),
        )
        session.commit()

    body = _test_rule(client, csrf, include_terms="iphone")

    texts = [m["message_text"] for m in body["messages"]]
    assert texts == ["iphone dentro da janela"]
    assert body["window_days"] == HISTORICAL_WINDOW.days


def test_deduplicates_the_same_real_message_matched_by_more_than_one_existing_rule(
    client: TestClient, sessionmaker_: sessionmaker[Session]
) -> None:
    csrf = login(client)
    with sessionmaker_() as session:
        source = Source(name="Grupo Teste", telegram_chat_id="-100999")
        session.add(source)
        session.flush()
        # Same real Telegram message, matched by two different existing
        # rules (rule_id differs) — must count once, not twice.
        _seed_match(
            session,
            source=source,
            text="iphone 15 por R$ 3.899",
            telegram_message_id=1,
            rule_id=1,
        )
        _seed_match(
            session,
            source=source,
            text="iphone 15 por R$ 3.899",
            telegram_message_id=1,
            rule_id=2,
        )
        session.commit()

    body = _test_rule(client, csrf, include_terms="iphone")

    assert body["total_matched"] == 1


def test_does_not_deduplicate_synthetic_messages_with_no_telegram_identity(
    client: TestClient, sessionmaker_: sessionmaker[Session]
) -> None:
    csrf = login(client)
    with sessionmaker_() as session:
        source = Source(name="Grupo Teste", telegram_chat_id="-100999")
        session.add(source)
        session.flush()
        _seed_match(
            session, source=source, text="iphone promo A", telegram_message_id=None, rule_id=1
        )
        _seed_match(
            session, source=source, text="iphone promo B", telegram_message_id=None, rule_id=1
        )
        session.commit()

    body = _test_rule(client, csrf, include_terms="iphone")

    assert body["total_matched"] == 2


def test_respects_exclude_terms_and_price_ceiling(
    client: TestClient, sessionmaker_: sessionmaker[Session]
) -> None:
    csrf = login(client)
    with sessionmaker_() as session:
        source = Source(name="Grupo Teste", telegram_chat_id="-100999")
        session.add(source)
        session.flush()
        _seed_match(
            session, source=source, text="iPhone usado, aceito troca", telegram_message_id=1
        )
        _seed_match(session, source=source, text="iPhone 15 por R$ 9.999", telegram_message_id=2)
        _seed_match(session, source=source, text="iPhone 15 por R$ 3.899", telegram_message_id=3)
        session.commit()

    body = _test_rule(
        client, csrf, include_terms="iphone", exclude_terms="usado", max_price_cents=500_000
    )

    texts = [m["message_text"] for m in body["messages"]]
    assert texts == ["iPhone 15 por R$ 3.899"]


def test_caps_the_returned_messages_but_reports_the_real_total(
    client: TestClient, sessionmaker_: sessionmaker[Session]
) -> None:
    csrf = login(client)
    with sessionmaker_() as session:
        source = Source(name="Grupo Teste", telegram_chat_id="-100999")
        session.add(source)
        session.flush()
        for i in range(60):
            _seed_match(session, source=source, text=f"iphone oferta {i}", telegram_message_id=i)
        session.commit()

    body = _test_rule(client, csrf, include_terms="iphone")

    assert body["total_matched"] == 60
    assert len(body["messages"]) == 50


def test_rejects_blank_include_terms(client: TestClient) -> None:
    csrf = login(client)

    response = client.post(
        "/rules/test", json={"include_terms": "   "}, headers={"x-csrf-token": csrf}
    )

    assert response.status_code == 422


def test_empty_history_returns_an_empty_preview(client: TestClient) -> None:
    csrf = login(client)

    body = _test_rule(client, csrf, include_terms="iphone")

    assert body == {"total_matched": 0, "window_days": HISTORICAL_WINDOW.days, "messages": []}
