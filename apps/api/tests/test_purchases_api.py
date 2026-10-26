# ruff: noqa: F811
"""S19-04: purchases CRUD and `GET /savings/report`, including what must never leak."""

import json
from datetime import timedelta
from typing import Any

from sqlalchemy import select
from tests.test_snoozes_api import NOW, ApiContext, _login_csrf, api  # noqa: F401

from models import Delivery, Match, Purchase, Recipient
from packages.metrics.counters import MetricCounter

SECRET_GROUP = "Grupo A"  # the Source name the fixture creates
SECRET_TEXT = "Placa-mãe Gigabyte B850M segredo-da-mensagem"
SECRET_URL = "https://loja.example/oferta-secreta"
SECRET_LINK = "https://t.me/c/999/42"
KEY = "gigabyte-b850m"


def _body(**overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "name": "Placa-mãe B850M",
        "price_cents": 120_000,
        "purchased_at": (NOW - timedelta(days=2)).isoformat(),
    }
    body.update(overrides)
    return body


def _add_prices(api: ApiContext, reais: list[int], *, key: str | None = KEY) -> None:
    with api.session_factory() as session:
        for index, price in enumerate(reais):
            session.add(
                Match(
                    source_id=api.ids["source"],
                    rule_id=api.ids["rule"],
                    telegram_message_id=1000 + index,
                    message_text=f"{SECRET_TEXT}\nR$ {price},00\n{SECRET_URL}",
                    message_link=SECRET_LINK,
                    price_cents=price * 100,
                    matched_at=NOW - timedelta(days=10 + index * 5),
                    product_key=key,
                )
            )
        session.commit()


def test_endpoints_need_a_session_and_csrf(api: ApiContext) -> None:
    assert api.client.post("/purchases", json=_body()).status_code == 403
    assert api.client.put("/purchases/1", json=_body()).status_code == 403
    assert api.client.delete("/purchases/1").status_code == 403
    api.client.post("/auth/logout")
    api.client.cookies.clear()
    assert api.client.get("/purchases").status_code == 401
    assert api.client.get("/savings/report").status_code == 401


def test_create_list_update_delete(api: ApiContext) -> None:
    headers = {"x-csrf-token": _login_csrf(api)}

    created = api.client.post("/purchases", json=_body(store="  Loja   Teste "), headers=headers)
    assert created.status_code == 201
    row = created.json()
    assert row["name"] == "Placa-mãe B850M"
    assert row["store"] == "Loja Teste"
    assert row["price_cents"] == 120_000
    assert row["purchased_at"].endswith("Z")

    assert [p["id"] for p in api.client.get("/purchases").json()] == [row["id"]]

    updated = api.client.put(
        f"/purchases/{row['id']}", json=_body(price_cents=99_900, store=None), headers=headers
    )
    assert updated.status_code == 200
    assert updated.json()["price_cents"] == 99_900
    assert updated.json()["store"] is None

    assert api.client.delete(f"/purchases/{row['id']}", headers=headers).status_code == 204
    assert api.client.get("/purchases").json() == []
    assert api.client.delete(f"/purchases/{row['id']}", headers=headers).status_code == 404
    assert api.client.put("/purchases/999", json=_body(), headers=headers).status_code == 404


def test_validation(api: ApiContext) -> None:
    headers = {"x-csrf-token": _login_csrf(api)}

    def post(**overrides: Any) -> int:
        return api.client.post("/purchases", json=_body(**overrides), headers=headers).status_code

    assert post(name="   ") == 422
    assert post(price_cents=0) == 422
    assert post(price_cents=-5) == 422
    assert post(price_cents=100_000_001) == 422
    assert post(purchased_at=(NOW + timedelta(days=10)).isoformat()) == 422
    assert post(rule_id=987_654) == 404
    assert post(rule_id=api.ids["rule"], product_key=KEY) == 201


def test_report_with_no_purchases_is_empty_and_honest(api: ApiContext) -> None:
    report = api.client.get("/savings/report").json()

    assert report["items"] == []
    assert report["totals"]["purchases"] == 0
    assert report["totals"]["estimated_saving_pct"] is None
    assert report["black_friday"]["date"] == "2026-11-27"
    assert report["black_friday"]["is_default"] is True


def test_report_compares_with_prices_seen_before_the_purchase(api: ApiContext) -> None:
    headers = {"x-csrf-token": _login_csrf(api)}
    _add_prices(api, [1_500, 1_600, 1_400, 1_700])
    api.client.post("/purchases", json=_body(product_key=KEY, price_cents=120_000), headers=headers)
    api.client.post("/purchases", json=_body(name="Cabo", price_cents=3_000), headers=headers)

    report = api.client.get("/savings/report").json()

    linked, loose = (
        next(i for i in report["items"] if i["name"] == "Placa-mãe B850M"),
        next(i for i in report["items"] if i["name"] == "Cabo"),
    )
    assert linked["linked"] is True
    assert linked["savings"]["status"] == "ok"
    assert linked["savings"]["median_90d_cents"] == 155_000
    assert linked["savings"]["saving_vs_median_cents"] == 35_000
    assert linked["savings"]["lowest_seen_cents"] == 140_000
    assert linked["savings"]["highest_seen_cents"] == 170_000
    assert linked["days_before_black_friday"] == 67  # bought 2026-09-21
    assert loose["linked"] is False
    assert loose["savings"] is None
    assert report["totals"]["total_paid_cents"] == 123_000
    assert report["totals"]["estimated_saving_cents"] == 35_000
    assert report["totals"]["linked_with_data"] == 1
    assert report["black_friday"]["purchases_before"] == 2


def test_report_rule_link_and_overpaying_and_no_data(api: ApiContext) -> None:
    headers = {"x-csrf-token": _login_csrf(api)}
    _add_prices(api, [1_000, 1_000, 1_100], key=None)
    api.client.post(
        "/purchases", json=_body(rule_id=api.ids["rule"], price_cents=150_000), headers=headers
    )
    api.client.post(
        "/purchases",
        json=_body(name="Raro", product_key="nunca-visto", price_cents=50_000),
        headers=headers,
    )

    items = {i["name"]: i for i in api.client.get("/savings/report").json()["items"]}

    assert items["Placa-mãe B850M"]["savings"]["saving_vs_median_cents"] == -50_000
    assert items["Raro"]["savings"]["status"] == "no_data"
    assert items["Raro"]["savings"]["saving_vs_median_cents"] is None


def test_report_custom_black_friday(api: ApiContext) -> None:
    headers = {"x-csrf-token": _login_csrf(api)}
    api.client.post("/purchases", json=_body(), headers=headers)

    report = api.client.get("/savings/report", params={"black_friday": "2026-10-30"}).json()

    assert report["black_friday"]["is_default"] is False
    assert report["black_friday"]["date"] == "2026-10-30"
    assert report["items"][0]["days_before_black_friday"] == 39  # bought 2026-09-21


def test_report_noise_is_aggregate_only(api: ApiContext) -> None:
    _add_prices(api, [1_500, 1_600])
    with api.session_factory() as session:
        recipient = Recipient(name="Alex", telegram_chat_id="1")
        session.add(recipient)
        session.flush()
        match_ids = list(session.scalars(select(Match.id)))
        session.add_all(
            [
                Delivery(
                    match_id=match_ids[0],
                    recipient_id=recipient.id,
                    status="sent",
                    created_at=NOW - timedelta(days=1),
                ),
                Delivery(
                    match_id=match_ids[1],
                    recipient_id=recipient.id,
                    status="grouped",
                    created_at=NOW - timedelta(days=1),
                ),
            ]
        )
        session.add_all(
            [
                MetricCounter(source_id=None, reason="vista", count=10),
                MetricCounter(source_id=None, reason="sem_termo", count=500),
                MetricCounter(source_id=None, reason="bloqueado", count=30),
                MetricCounter(source_id=None, reason="preco_acima_teto", count=7),
            ]
        )
        session.commit()

    noise = api.client.get("/savings/report").json()["noise"]

    assert noise["messages_analyzed"] == 547
    assert noise["discarded"] == {"sem_termo": 500, "bloqueado": 30, "preco_acima_teto": 7}
    assert noise["alerts_matched"] == 2
    assert noise["alerts_sent"] == 1
    assert noise["duplicates_grouped"] == 1
    assert noise["counters_scope"] == "all_time"


def test_report_and_purchases_never_expose_telegram_content(api: ApiContext) -> None:
    headers = {"x-csrf-token": _login_csrf(api)}
    _add_prices(api, [1_500, 1_600, 1_400])
    api.client.post("/purchases", json=_body(product_key=KEY), headers=headers)

    payloads = [
        api.client.get("/savings/report").text,
        api.client.get("/purchases").text,
    ]
    for text in payloads:
        for secret in (SECRET_GROUP, SECRET_TEXT, "segredo-da-mensagem", SECRET_URL, SECRET_LINK):
            assert secret not in text
        assert "http" not in text
    json.loads(payloads[0])  # still valid JSON


def test_purchase_table_has_no_telegram_content_columns() -> None:
    columns = {column.name for column in Purchase.__table__.columns}

    assert columns == {
        "id",
        "name",
        "price_cents",
        "purchased_at",
        "store",
        "product_key",
        "rule_id",
        "created_at",
    }
