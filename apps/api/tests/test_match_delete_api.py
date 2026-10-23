"""S20-01: `DELETE /matches/{id}` and `DELETE /products/{key}/matches`.

Reuses the `api` fixture of `test_match_correction_api.py` (real app, in-memory
schema, logged-in client).
"""

# ruff: noqa: F811
from datetime import timedelta

from httpx import Response
from sqlalchemy import func, select
from test_match_correction_api import (
    NOW,
    RTX_KEY,
    ApiContext,
    _add_match,
    _login_csrf,
    api,  # noqa: F401  (pytest fixture, reused as is)
)

from app.pipeline import IncomingMessage, _persist_match
from models import Delivery, Match, MatchCorrection, Rule, SuppressedMessage


def _count(api: ApiContext, model: type) -> int:
    with api.session_factory() as session:
        return int(session.scalar(select(func.count()).select_from(model)) or 0)


def _delete(api: ApiContext, path: str, csrf: str | None = None) -> Response:
    headers = {"x-csrf-token": csrf} if csrf is not None else {}
    return api.client.delete(path, headers=headers)


def test_delete_match_removes_it_and_its_dependents(api: ApiContext) -> None:
    csrf = _login_csrf(api)
    match_id = _add_match(api, telegram_message_id=10)
    keep_id = _add_match(api, price_cents=600_000, telegram_message_id=11)
    with api.session_factory() as session:
        session.add(Delivery(match_id=match_id, recipient_id=api.ids["recipient"]))
        session.add(MatchCorrection(match_id=match_id, admin_id=1, changes={"x": 1}))
        session.commit()

    response = _delete(api, f"/matches/{match_id}", csrf)

    assert response.status_code == 204
    assert _count(api, Delivery) == 0
    assert _count(api, MatchCorrection) == 0
    with api.session_factory() as session:
        assert session.get(Match, match_id) is None
        assert session.get(Match, keep_id) is not None


def test_delete_match_requires_csrf_and_404s_when_missing(api: ApiContext) -> None:
    match_id = _add_match(api)
    csrf = _login_csrf(api)

    assert _delete(api, f"/matches/{match_id}").status_code == 403
    assert _delete(api, "/matches/99999", csrf).status_code == 404
    assert _delete(api, f"/matches/{match_id}", csrf).status_code == 204
    assert _delete(api, f"/matches/{match_id}", csrf).status_code == 404


def test_wrong_price_stops_counting_in_lowest_price_and_product_history(api: ApiContext) -> None:
    csrf = _login_csrf(api)
    _add_match(api, price_cents=574_900, telegram_message_id=1, matched_at=NOW - timedelta(days=2))
    typo_id = _add_match(
        api, price_cents=69_900, telegram_message_id=2, matched_at=NOW - timedelta(days=1)
    )

    before = api.client.get(f"/products/{RTX_KEY}").json()
    assert before["lowest_90d_cents"] == 69_900
    feed = {item["id"]: item for item in api.client.get("/matches").json()}
    assert any(item["is_lowest_price_ever"] for item in feed.values())

    assert _delete(api, f"/matches/{typo_id}", csrf).status_code == 204

    after = api.client.get(f"/products/{RTX_KEY}").json()
    assert after["lowest_90d_cents"] == 574_900
    assert after["total_count"] == 1
    assert all(point["price_cents"] != 69_900 for point in after["series"])
    remaining = api.client.get("/matches").json()
    assert [item["price_cents"] for item in remaining] == [574_900]
    assert remaining[0]["is_lowest_price_ever"] is True


def test_delete_removes_sibling_matches_of_the_same_message(api: ApiContext) -> None:
    csrf = _login_csrf(api)
    first = _add_match(api, telegram_message_id=77)
    _add_match(api, rule_id=api.ids["rule_no_target"], telegram_message_id=77)
    other = _add_match(api, telegram_message_id=78)

    assert _delete(api, f"/matches/{first}", csrf).status_code == 204

    with api.session_factory() as session:
        assert [row.id for row in session.scalars(select(Match))] == [other]


def test_delete_product_matches_removes_every_record_with_count(api: ApiContext) -> None:
    csrf = _login_csrf(api)
    _add_match(api, telegram_message_id=1)
    _add_match(api, telegram_message_id=2, price_cents=600_000)
    other = _add_match(api, product_key="outro-produto", telegram_message_id=3)

    assert _delete(api, f"/products/{RTX_KEY}/matches").status_code == 403
    response = _delete(api, f"/products/{RTX_KEY}/matches", csrf)

    assert response.status_code == 200
    assert response.json() == {"deleted": 2}
    assert api.client.get(f"/products/{RTX_KEY}").status_code == 404
    assert _delete(api, f"/products/{RTX_KEY}/matches", csrf).status_code == 404
    with api.session_factory() as session:
        assert [row.id for row in session.scalars(select(Match))] == [other]


def test_deleted_message_is_not_recreated_by_the_pipeline(api: ApiContext) -> None:
    csrf = _login_csrf(api)
    match_id = _add_match(api, telegram_message_id=555)
    assert _delete(api, f"/matches/{match_id}", csrf).status_code == 204
    assert _count(api, SuppressedMessage) == 1

    message = IncomingMessage(
        source_id=api.ids["source"],
        text="Placa de Vídeo Palit RTX 5070 Ti 16GB R$ 699,00",
        received_at=NOW,
        message_id=555,
        link=None,
    )
    with api.session_factory() as session:
        rule = session.get(Rule, api.ids["rule"])
        assert rule is not None
        assert _persist_match(session, message, rule, 69_900) is None
        replay = IncomingMessage(
            source_id=api.ids["source"],
            text=message.text,
            received_at=NOW,
            message_id=556,
            link=None,
        )
        assert _persist_match(session, replay, rule, 69_900) is not None
        session.commit()
    with api.session_factory() as session:
        assert list(session.scalars(select(Match.telegram_message_id))) == [556]


def test_delete_publishes_a_match_deleted_event(api: ApiContext) -> None:
    from app.main import app

    csrf = _login_csrf(api)
    match_id = _add_match(api, telegram_message_id=9)
    broker = app.state.event_broker
    subscription = broker.subscribe(None)
    try:
        assert _delete(api, f"/matches/{match_id}", csrf).status_code == 204
        event = subscription.queue.get_nowait()
        assert event is not None
        assert (event.type, event.data) == ("match_deleted", {"ids": [match_id]})
    finally:
        broker.unsubscribe(subscription.id)
