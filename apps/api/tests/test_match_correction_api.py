"""S14-06 (F7): `PATCH /matches/{id}` (manual product edit) and
`POST /matches/{id}/revert` ("Reverter ao detectado").

Mirrors the fixture shape of `test_snoozes_api.py` (real Alembic schema via
the `session`-free in-memory `Base.metadata.create_all`) plus the
`get_bot_notifier_factory` override style of `test_demo_api.py`, so the
target-alert channel (`DELIVERY_KIND_MANUAL_TARGET`) can be asserted against
a real `FakeBotClient` instead of only the DB rows it leaves behind.
"""

import asyncio
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from threading import Barrier

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, create_engine, select
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.main import app
from app.routers.matches import (
    _deliver_reserved_manual_target_alerts,
    _reserve_manual_target_alerts_if_hit,
)
from app.routers.notifications import BotNotifierFactory, get_bot_notifier_factory
from app.utc import utc_now
from auth.hashing import hash_password
from auth.rate_limit import LoginRateLimiter
from auth.session import SessionStore
from models import Admin, Delivery, Match, MatchCorrection, Recipient, Rule, Source
from models.base import Base
from models.db import get_engine
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


def _get_match(api: ApiContext, match_id: int) -> Match:
    with api.session_factory() as session:
        match = session.get(Match, match_id)
        assert match is not None
        session.expunge(match)
        return match


def _corrections_for(api: ApiContext, match_id: int) -> list[MatchCorrection]:
    with api.session_factory() as session:
        return list(
            session.scalars(
                select(MatchCorrection)
                .where(MatchCorrection.match_id == match_id)
                .order_by(MatchCorrection.id)
            )
        )


def _deliveries_for(api: ApiContext, match_id: int, kind: str) -> list[Delivery]:
    with api.session_factory() as session:
        return list(
            session.scalars(
                select(Delivery).where(Delivery.match_id == match_id, Delivery.kind == kind)
            )
        )


# --- auth / csrf -------------------------------------------------------


def test_patch_requires_a_session(api: ApiContext) -> None:
    match_id = _add_match(api)
    api.client.post("/auth/logout")
    api.client.cookies.clear()

    response = api.client.patch(f"/matches/{match_id}", json={"display_name": "RTX 5070 Ti"})

    assert response.status_code == 401


def test_patch_requires_csrf(api: ApiContext) -> None:
    match_id = _add_match(api)

    response = api.client.patch(f"/matches/{match_id}", json={"display_name": "RTX 5070 Ti"})

    assert response.status_code == 403


def test_revert_requires_csrf(api: ApiContext) -> None:
    match_id = _add_match(api)

    response = api.client.post(f"/matches/{match_id}/revert")

    assert response.status_code == 403


# --- 404 -----------------------------------------------------------------


def test_patch_unknown_match_is_404(api: ApiContext) -> None:
    csrf = _login_csrf(api)

    response = api.client.patch(
        "/matches/999999", json={"display_name": "X"}, headers={"x-csrf-token": csrf}
    )

    assert response.status_code == 404


def test_revert_unknown_match_is_404(api: ApiContext) -> None:
    csrf = _login_csrf(api)

    response = api.client.post("/matches/999999/revert", headers={"x-csrf-token": csrf})

    assert response.status_code == 404


# --- validation ------------------------------------------------------------


@pytest.mark.parametrize(
    "raw_price",
    ["5.749,00", "5749", "5749.5", "5.749", "5749,00"],
)
def test_patch_accepts_documented_price_formats(api: ApiContext, raw_price: str) -> None:
    match_id = _add_match(api, rule_id=api.ids["rule_no_target"], price_cents=None)
    csrf = _login_csrf(api)

    response = api.client.patch(
        f"/matches/{match_id}", json={"price": raw_price}, headers={"x-csrf-token": csrf}
    )

    assert response.status_code == 200
    assert response.json()["price_source"] == "manual"


@pytest.mark.parametrize("raw_price", ["", "abc", "5,749.00", "5.749,999", "-100", "0"])
def test_patch_rejects_ambiguous_or_invalid_prices_with_a_pt_br_message(
    api: ApiContext, raw_price: str
) -> None:
    match_id = _add_match(api, rule_id=api.ids["rule_no_target"])
    csrf = _login_csrf(api)

    response = api.client.patch(
        f"/matches/{match_id}", json={"price": raw_price}, headers={"x-csrf-token": csrf}
    )

    assert response.status_code == 422
    assert response.json()["detail"]


@pytest.mark.parametrize("name", ["", "ab", "x" * 121])
def test_patch_rejects_display_name_outside_3_to_120_chars(api: ApiContext, name: str) -> None:
    match_id = _add_match(api, rule_id=api.ids["rule_no_target"])
    csrf = _login_csrf(api)

    response = api.client.patch(
        f"/matches/{match_id}", json={"display_name": name}, headers={"x-csrf-token": csrf}
    )

    assert response.status_code == 422


@pytest.mark.parametrize("name", ["abc", "RTX 5070 Ti Gaming Pro", "x" * 120])
def test_patch_accepts_display_name_within_3_to_120_chars(api: ApiContext, name: str) -> None:
    match_id = _add_match(api, rule_id=api.ids["rule_no_target"])
    csrf = _login_csrf(api)

    response = api.client.patch(
        f"/matches/{match_id}", json={"display_name": name}, headers={"x-csrf-token": csrf}
    )

    assert response.status_code == 200
    assert response.json()["display_name"] == name


# --- message_text is never touched -----------------------------------


def test_patch_never_rewrites_message_text(api: ApiContext) -> None:
    match_id = _add_match(api, rule_id=api.ids["rule_no_target"])
    csrf = _login_csrf(api)

    response = api.client.patch(
        f"/matches/{match_id}",
        json={"display_name": "RTX 5070 Ti", "model_variant": "GamingPro", "price": "5749"},
        headers={"x-csrf-token": csrf},
    )

    assert response.status_code == 200
    assert response.json()["message_text"] == RTX_TEXT
    assert _get_match(api, match_id).message_text == RTX_TEXT


# --- audit trail -------------------------------------------------------


def test_patch_records_a_correction_with_before_and_after(api: ApiContext) -> None:
    match_id = _add_match(api, rule_id=api.ids["rule_no_target"], price_cents=574_900)
    csrf = _login_csrf(api)

    response = api.client.patch(
        f"/matches/{match_id}",
        json={"display_name": "RTX 5070 Ti", "price": "5.999,00"},
        headers={"x-csrf-token": csrf},
    )
    assert response.status_code == 200

    corrections = _corrections_for(api, match_id)
    assert len(corrections) == 1
    assert corrections[0].admin_id == api.ids["recipient"] or corrections[0].admin_id >= 1
    assert corrections[0].changes["display_name"] == {"before": None, "after": "RTX 5070 Ti"}
    assert corrections[0].changes["price_cents"] == {"before": 574_900, "after": 599_900}

    body = response.json()
    assert body["last_correction"] is not None
    assert body["last_correction"]["admin_id"] == corrections[0].admin_id


def test_patch_with_no_actual_changes_records_no_correction(api: ApiContext) -> None:
    match_id = _add_match(api, rule_id=api.ids["rule_no_target"], price_cents=574_900)
    csrf = _login_csrf(api)

    response = api.client.patch(
        f"/matches/{match_id}", json={"price": "5749,00"}, headers={"x-csrf-token": csrf}
    )

    assert response.status_code == 200
    assert response.json()["price_source"] is None
    assert _corrections_for(api, match_id) == []


def test_original_price_cents_is_captured_once_and_never_overwritten(api: ApiContext) -> None:
    match_id = _add_match(api, rule_id=api.ids["rule_no_target"], price_cents=574_900)
    csrf = _login_csrf(api)

    first = api.client.patch(
        f"/matches/{match_id}", json={"price": "5999"}, headers={"x-csrf-token": csrf}
    )
    assert first.json()["original_price_cents"] == 574_900

    second = api.client.patch(
        f"/matches/{match_id}", json={"price": "6499"}, headers={"x-csrf-token": csrf}
    )
    assert second.json()["original_price_cents"] == 574_900
    assert second.json()["price_cents"] == 649_900


def test_revert_preserves_a_legitimate_null_detected_price_across_multiple_edits(
    api: ApiContext,
) -> None:
    match_id = _add_match(api, rule_id=api.ids["rule_no_target"], price_cents=None)
    csrf = _login_csrf(api)

    first = api.client.patch(
        f"/matches/{match_id}", json={"price": "100"}, headers={"x-csrf-token": csrf}
    )
    second = api.client.patch(
        f"/matches/{match_id}", json={"price": "90"}, headers={"x-csrf-token": csrf}
    )
    reverted = api.client.post(f"/matches/{match_id}/revert", headers={"x-csrf-token": csrf})

    assert first.json()["original_price_cents"] is None
    assert second.json()["original_price_cents"] is None
    assert reverted.json()["price_cents"] is None
    assert reverted.json()["price_source"] == "parsed"


# --- revert ----------------------------------------------------------------


def test_revert_restores_the_detected_price_and_clears_edit_fields(api: ApiContext) -> None:
    match_id = _add_match(api, rule_id=api.ids["rule_no_target"], price_cents=574_900)
    csrf = _login_csrf(api)
    api.client.patch(
        f"/matches/{match_id}",
        json={"display_name": "RTX 5070 Ti", "model_variant": "GamingPro", "price": "5999"},
        headers={"x-csrf-token": csrf},
    )

    response = api.client.post(f"/matches/{match_id}/revert", headers={"x-csrf-token": csrf})

    assert response.status_code == 200
    body = response.json()
    assert body["price_cents"] == 574_900
    assert body["display_name"] is None
    assert body["model_variant"] is None
    assert body["price_source"] == "parsed"

    match = _get_match(api, match_id)
    assert match.original_price_cents == 574_900  # kept, never cleared


def test_revert_on_an_unedited_match_is_a_no_op(api: ApiContext) -> None:
    match_id = _add_match(api, rule_id=api.ids["rule_no_target"], price_cents=574_900)
    csrf = _login_csrf(api)

    response = api.client.post(f"/matches/{match_id}/revert", headers={"x-csrf-token": csrf})

    assert response.status_code == 200
    assert response.json()["price_cents"] == 574_900
    assert response.json()["price_source"] is None
    assert _corrections_for(api, match_id) == []


# --- target alert: single-fire idempotency ----------------------------


def test_price_at_or_below_target_sends_the_manual_target_alert_once(api: ApiContext) -> None:
    match_id = _add_match(api, price_cents=650_000)  # api.ids["rule"] has target 560_000
    csrf = _login_csrf(api)

    first = api.client.patch(
        f"/matches/{match_id}", json={"price": "5.500,00"}, headers={"x-csrf-token": csrf}
    )
    assert first.status_code == 200

    deliveries = _deliveries_for(api, match_id, "manual_target")
    assert len(deliveries) == 1
    assert deliveries[0].status == "sent"
    assert len(api.bot_client.sent) == 1
    chat_id, text = api.bot_client.sent[0]
    assert chat_id == "999"
    assert "🎯" in text
    assert RTX_TEXT in text

    # Saving again (even with a further price drop) must never send twice.
    second = api.client.patch(
        f"/matches/{match_id}", json={"price": "5.400,00"}, headers={"x-csrf-token": csrf}
    )
    assert second.status_code == 200
    assert len(_deliveries_for(api, match_id, "manual_target")) == 1
    assert len(api.bot_client.sent) == 1


def test_revert_then_save_again_does_not_resend(api: ApiContext) -> None:
    match_id = _add_match(api, price_cents=650_000)
    csrf = _login_csrf(api)

    api.client.patch(
        f"/matches/{match_id}", json={"price": "5.500,00"}, headers={"x-csrf-token": csrf}
    )
    assert len(api.bot_client.sent) == 1

    api.client.post(f"/matches/{match_id}/revert", headers={"x-csrf-token": csrf})
    api.client.patch(
        f"/matches/{match_id}", json={"price": "5.450,00"}, headers={"x-csrf-token": csrf}
    )

    assert len(api.bot_client.sent) == 1
    assert len(_deliveries_for(api, match_id, "manual_target")) == 1


def test_price_above_target_does_not_alert(api: ApiContext) -> None:
    match_id = _add_match(api, price_cents=650_000)  # target is 560_000
    csrf = _login_csrf(api)

    response = api.client.patch(
        f"/matches/{match_id}", json={"price": "6.200,00"}, headers={"x-csrf-token": csrf}
    )

    assert response.status_code == 200
    assert _deliveries_for(api, match_id, "manual_target") == []
    assert api.bot_client.sent == []


def test_not_configured_notifier_never_fakes_delivery(api: ApiContext) -> None:
    api.bot_state["token"] = None
    match_id = _add_match(api, price_cents=650_000)
    csrf = _login_csrf(api)

    response = api.client.patch(
        f"/matches/{match_id}", json={"price": "5.500,00"}, headers={"x-csrf-token": csrf}
    )

    assert response.status_code == 200
    deliveries = _deliveries_for(api, match_id, "manual_target")
    assert len(deliveries) == 1
    assert deliveries[0].status == "not_configured"
    assert deliveries[0].delivered_at is None
    assert api.bot_client.sent == []

    # Even once the bot becomes configured later, a repeat save never
    # retries the same (match, recipient, kind) pair.
    api.bot_state["token"] = "token"
    api.client.patch(
        f"/matches/{match_id}", json={"price": "5.400,00"}, headers={"x-csrf-token": csrf}
    )
    assert len(_deliveries_for(api, match_id, "manual_target")) == 1
    assert api.bot_client.sent == []


def test_crash_after_external_send_leaves_a_durable_non_retryable_reservation(
    api: ApiContext,
) -> None:
    class SimulatedProcessCrash(BaseException):
        pass

    match_id = _add_match(api, price_cents=550_000)

    async def send_then_crash(chat_id: str, text: str) -> None:
        api.bot_client.sent.append((chat_id, text))
        raise SimulatedProcessCrash

    api.bot_client.send_message = send_then_crash  # type: ignore[method-assign]
    with api.session_factory() as session:
        match = session.get(Match, match_id)
        assert match is not None
        reservations = _reserve_manual_target_alerts_if_hit(session, match)

        def notifier_factory(allowlisted_chat_ids: set[str]) -> BotNotifier:
            return BotNotifier(
                bot_token="token",
                client=api.bot_client,
                allowlisted_chat_ids=allowlisted_chat_ids,
            )

        with pytest.raises(SimulatedProcessCrash):
            asyncio.run(
                _deliver_reserved_manual_target_alerts(
                    session, match, reservations, notifier_factory
                )
            )

    deliveries = _deliveries_for(api, match_id, "manual_target")
    assert len(deliveries) == 1
    assert deliveries[0].status == "pending"

    replacement_client = FakeBotClient()

    def replacement_factory() -> BotNotifierFactory:
        def factory(allowlisted_chat_ids: set[str]) -> BotNotifier:
            return BotNotifier(
                bot_token="token",
                client=replacement_client,
                allowlisted_chat_ids=allowlisted_chat_ids,
            )

        return factory

    app.dependency_overrides[get_bot_notifier_factory] = replacement_factory
    csrf = _login_csrf(api)
    response = api.client.patch(
        f"/matches/{match_id}",
        json={"price": "5.400,00"},
        headers={"x-csrf-token": csrf},
    )

    assert response.status_code == 200
    assert replacement_client.sent == []
    assert len(_deliveries_for(api, match_id, "manual_target")) == 1


def test_concurrent_manual_target_reservations_have_one_winner(tmp_path: Path) -> None:
    engine = get_engine(f"sqlite:///{tmp_path / 'concurrent.db'}")
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    with factory() as session:
        source = Source(name="Grupo", telegram_chat_id="-100")
        rule = Rule(name="RTX", include_terms="rtx", target_price_cents=560_000)
        recipient = Recipient(name="Gabriel", telegram_chat_id="999", active=True, allowlisted=True)
        session.add_all([source, rule, recipient])
        session.flush()
        match = Match(
            source_id=source.id,
            rule_id=rule.id,
            message_text=RTX_TEXT,
            price_cents=550_000,
            matched_at=NOW,
        )
        session.add(match)
        session.commit()
        match_id = match.id

    barrier = Barrier(2)

    def reserve() -> int:
        with factory() as session:
            match = session.get(Match, match_id)
            assert match is not None
            barrier.wait()
            return len(_reserve_manual_target_alerts_if_hit(session, match))

    with ThreadPoolExecutor(max_workers=2) as executor:
        winners = list(executor.map(lambda _: reserve(), range(2)))

    assert sorted(winners) == [0, 1]
    with factory() as session:
        deliveries = list(
            session.scalars(
                select(Delivery).where(
                    Delivery.match_id == match_id,
                    Delivery.kind == "manual_target",
                )
            )
        )
        assert len(deliveries) == 1
        assert deliveries[0].status == "pending"
    engine.dispose()


# --- product history reflects the manual price --------------------------


def test_product_history_reflects_the_manual_price(api: ApiContext) -> None:
    match_id = _add_match(
        api, rule_id=api.ids["rule_no_target"], price_cents=574_900, product_key=RTX_KEY
    )
    csrf = _login_csrf(api)

    api.client.patch(
        f"/matches/{match_id}", json={"price": "4.999,00"}, headers={"x-csrf-token": csrf}
    )

    product = api.client.get(f"/products/{RTX_KEY}").json()
    assert product["current_price_cents"] == 499_900
    assert product["lowest_90d_cents"] == 499_900
    assert any(point["price_cents"] == 499_900 for point in product["series"])


def test_product_history_prefers_the_latest_manual_duplicate_without_double_counting(
    api: ApiContext,
) -> None:
    _add_match(
        api,
        rule_id=api.ids["rule_no_target"],
        price_cents=574_900,
        product_key=RTX_KEY,
        telegram_message_id=77,
    )
    edited_id = _add_match(
        api,
        rule_id=api.ids["rule_dup"],
        price_cents=574_900,
        product_key=RTX_KEY,
        telegram_message_id=77,
    )
    csrf = _login_csrf(api)

    response = api.client.patch(
        f"/matches/{edited_id}",
        json={"price": "4.999,00"},
        headers={"x-csrf-token": csrf},
    )
    assert response.status_code == 200

    product = api.client.get(f"/products/{RTX_KEY}").json()
    assert product["total_count"] == 1
    assert product["current_price_cents"] == 499_900
    assert len(product["postings"]) == 1
    assert product["postings"][0]["id"] == edited_id
    assert product["postings"][0]["price_cents"] == 499_900
    assert [point["price_cents"] for point in product["series"]] == [499_900]


# --- apply_name_to_product ----------------------------------------------


def test_apply_name_to_product_only_touches_display_name_of_the_same_product_key(
    api: ApiContext,
) -> None:
    edited_id = _add_match(
        api, rule_id=api.ids["rule_no_target"], price_cents=574_900, product_key=RTX_KEY
    )
    sibling_id = _add_match(
        api, rule_id=api.ids["rule_no_target"], price_cents=599_900, product_key=RTX_KEY
    )
    other_product_id = _add_match(
        api, rule_id=api.ids["rule_no_target"], price_cents=100_000, product_key="other-product"
    )
    csrf = _login_csrf(api)

    response = api.client.patch(
        f"/matches/{edited_id}",
        json={
            "display_name": "RTX 5070 Ti 16GB",
            "model_variant": "GamingPro",
            "apply_name_to_product": True,
        },
        headers={"x-csrf-token": csrf},
    )
    assert response.status_code == 200

    sibling = _get_match(api, sibling_id)
    assert sibling.display_name == "RTX 5070 Ti 16GB"
    assert sibling.model_variant is None  # only display_name is rewritten
    assert sibling.price_cents == 599_900  # untouched

    other_product = _get_match(api, other_product_id)
    assert other_product.display_name is None

    sibling_corrections = _corrections_for(api, sibling_id)
    assert len(sibling_corrections) == 1
    assert sibling_corrections[0].changes == {
        "display_name": {"before": None, "after": "RTX 5070 Ti 16GB"}
    }


def test_apply_name_to_product_requires_display_name(api: ApiContext) -> None:
    match_id = _add_match(api, rule_id=api.ids["rule_no_target"])
    csrf = _login_csrf(api)

    response = api.client.patch(
        f"/matches/{match_id}",
        json={"apply_name_to_product": True},
        headers={"x-csrf-token": csrf},
    )

    assert response.status_code == 422


# --- coexistence with S14-05's read-time duplicate grouping -----------


def test_grouped_representative_uses_its_own_display_name(api: ApiContext) -> None:
    """S14-05 folds two postings of the same `product_key`/price (from
    different rules, within `GROUPING_WINDOW`) into one card, and the
    earliest-`matched_at` member becomes that card's representative
    (`_attach_duplicate_group`). Editing the representative's own
    `display_name` must be exactly what a grouped card shows — never a
    hidden sibling's, and never merged/blank just because grouping ran.
    """
    representative_id = _add_match(
        api,
        rule_id=api.ids["rule_no_target"],
        source_id=api.ids["source"],
        price_cents=574_900,
        matched_at=NOW,
    )
    _add_match(
        api,
        rule_id=api.ids["rule_dup"],
        source_id=api.ids["other_source"],
        price_cents=574_900,
        matched_at=NOW + timedelta(minutes=5),
    )
    csrf = _login_csrf(api)

    patched = api.client.patch(
        f"/matches/{representative_id}",
        json={"display_name": "RTX 5070 Ti 16GB"},
        headers={"x-csrf-token": csrf},
    )
    assert patched.status_code == 200

    feed = {item["id"]: item for item in api.client.get("/matches").json()}
    representative = feed[representative_id]

    assert representative["seen_count"] == 2
    assert len(representative["grouped_match_ids"]) == 2
    assert representative_id in representative["grouped_match_ids"]
    assert representative["display_name"] == "RTX 5070 Ti 16GB"
    # The folded sibling never appears as its own card once grouped.
    assert len(feed) == 1
