"""Shared fixture and helpers for the match API tests (S14-06, S20-01).

Originally in test_match_correction_api.py (S14-06 docs below).

S14-06 (F7): `PATCH /matches/{id}` (manual product edit) and
`POST /matches/{id}/revert` ("Reverter ao detectado").

Mirrors the fixture shape of `test_snoozes_api.py` (real Alembic schema via
the `session`-free in-memory `Base.metadata.create_all`) plus the
`get_bot_notifier_factory` override style of `test_demo_api.py`, so the
target-alert channel (`DELIVERY_KIND_MANUAL_TARGET`) can be asserted against
a real `FakeBotClient` instead of only the DB rows it leaves behind.
"""

from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.main import app
from app.routers.notifications import BotNotifierFactory, get_bot_notifier_factory
from app.utc import utc_now
from auth.hashing import hash_password
from auth.rate_limit import LoginRateLimiter
from auth.session import SessionStore
from models import Admin, Match, Recipient, Rule, Source
from models.base import Base
from packages.notifications.bot import BotNotifier
from packages.notifications.fakes import FakeBotClient

PASSWORD = "correct horse battery staple"
NOW = datetime(2026, 9, 24, 12, 0, tzinfo=UTC)
RTX_TEXT = "Placa de Vídeo Palit RTX 5070 Ti 16GB\n\n💵 R$ 5.749,00 no pix\nhttps://loja.example/p"
RTX_KEY = "palit-rtx-5070-ti"


@dataclass
class ApiContext:
    client: TestClient
    session_factory: sessionmaker[Session]
    bot_client: FakeBotClient
    bot_state: dict[str, str | None]
    ids: dict[str, int] = field(default_factory=dict)


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
        other_source = Source(name="Grupo B", telegram_chat_id="-1002")
        rule = Rule(name="RTX 5070 Ti", include_terms="rtx 5070 ti", target_price_cents=560_000)
        rule_no_target = Rule(name="Sem alvo", include_terms="notebook")
        # A second, distinct rule for the duplicate-grouping test below — same
        # reasoning as `test_feed_grouping_api.py`'s own fixture: the older
        # S7-11 rule+price grouping keys on `rule_id`, so two matches sharing
        # one rule would fold together before S14-05's product-key grouping
        # ever gets a chance to run.
        rule_dup = Rule(name="Duplicatas", include_terms="rtx dup")
        recipient = Recipient(name="Gabriel", telegram_chat_id="999", allowlisted=True)
        setup_session.add_all(
            [source, other_source, rule, rule_no_target, rule_dup, recipient]
        )
        setup_session.commit()
        ids = {
            "source": source.id,
            "other_source": other_source.id,
            "rule": rule.id,
            "rule_no_target": rule_no_target.id,
            "rule_dup": rule_dup.id,
            "recipient": recipient.id,
        }

    bot_client = FakeBotClient()
    bot_state: dict[str, str | None] = {"token": "token"}

    def notifier_factory() -> BotNotifierFactory:
        def factory(allowlisted_chat_ids: set[str]) -> BotNotifier:
            return BotNotifier(
                bot_token=bot_state["token"],
                client=bot_client,
                allowlisted_chat_ids=allowlisted_chat_ids,
            )

        return factory

    state_names = ("session_store", "rate_limiter", "session_factory")
    previous_state = {name: getattr(app.state, name) for name in state_names}
    previous_overrides = app.dependency_overrides.copy()
    try:
        app.state.session_factory = test_sessionmaker
        app.state.session_store = SessionStore()
        app.state.rate_limiter = LoginRateLimiter()
        app.dependency_overrides.clear()
        app.dependency_overrides[utc_now] = lambda: NOW
        app.dependency_overrides[get_bot_notifier_factory] = notifier_factory
        with TestClient(app, base_url="https://testserver") as client:
            response = client.post("/auth/login", json={"password": PASSWORD})
            assert response.status_code == 200
            yield ApiContext(
                client=client,
                session_factory=test_sessionmaker,
                bot_client=bot_client,
                bot_state=bot_state,
                ids=ids,
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
    rule_id: int | None = None,
    source_id: int | None = None,
    price_cents: int | None = 574_900,
    product_key: str | None = RTX_KEY,
    text: str = RTX_TEXT,
    matched_at: datetime = NOW,
    telegram_message_id: int | None = None,
) -> int:
    with api.session_factory() as session:
        match = Match(
            source_id=source_id if source_id is not None else api.ids["source"],
            rule_id=rule_id if rule_id is not None else api.ids["rule"],
            message_text=text,
            price_cents=price_cents,
            matched_at=matched_at,
            product_key=product_key,
            telegram_message_id=telegram_message_id,
        )
        session.add(match)
        session.commit()
        return match.id
