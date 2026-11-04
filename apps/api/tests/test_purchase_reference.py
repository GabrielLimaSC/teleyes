# ruff: noqa: F811
"""S22-01: link by rule, and the reference price typed by the user (kept apart)."""

from datetime import timedelta
from pathlib import Path
from typing import Any

from sqlalchemy import select
from tests.conftest import AlembicRunner
from tests.test_purchases_api import KEY, _add_prices, _body
from tests.test_snoozes_api import NOW, ApiContext, _login_csrf, api  # noqa: F401

from app.savings import reference_saving, uses_reference
from models import Purchase
from models.db import get_engine

PREVIOUS_HEAD = "c5a8e3d17f42"


def _post(api: ApiContext, **overrides: Any) -> dict[str, Any]:
    headers = {"x-csrf-token": _login_csrf(api)}
    response = api.client.post("/purchases", json=_body(**overrides), headers=headers)
    assert response.status_code == 201, response.text
    body: dict[str, Any] = response.json()
    return body


def _items(api: ApiContext) -> dict[str, dict[str, Any]]:
    report = api.client.get("/savings/report").json()
    return {item["name"]: item for item in report["items"]}


def test_rule_link_uses_min_median_max_of_the_rule_matches(api: ApiContext) -> None:
    _add_prices(api, [1_000, 1_200, 1_400, 1_600], key=None)
    _post(api, rule_id=api.ids["rule"], price_cents=100_000)

    item = _items(api)["Placa-mãe B850M"]

    assert item["link_kind"] == "rule"
    assert item["link_label"] == "Placas"
    assert item["linked"] is True
    assert item["savings"]["status"] == "ok"
    assert item["savings"]["lowest_seen_cents"] == 100_000
    assert item["savings"]["median_90d_cents"] == 130_000
    assert item["savings"]["highest_seen_cents"] == 160_000
    assert item["savings"]["saving_vs_median_cents"] == 30_000


def test_rule_with_fewer_than_three_prices_stays_without_history(api: ApiContext) -> None:
    _add_prices(api, [1_000, 1_200], key=None)
    _post(api, rule_id=api.ids["rule"])

    item = _items(api)["Placa-mãe B850M"]

    assert item["savings"]["status"] == "no_data"
    assert item["savings"]["saving_vs_median_cents"] is None
    assert item["reference"] is None


def test_product_link_reports_its_kind_without_a_label(api: ApiContext) -> None:
    _post(api, product_key=KEY)

    item = _items(api)["Placa-mãe B850M"]

    assert (item["link_kind"], item["link_label"]) == ("product", None)


def test_reference_is_used_only_without_teleyes_history(api: ApiContext) -> None:
    _add_prices(api, [1_500, 1_600, 1_400])
    _post(
        api,
        name="SSD",
        price_cents=40_000,
        reference_price_cents=50_000,
        reference_note="média do Google Shopping",
    )
    _post(
        api,
        name="Placa",
        product_key=KEY,
        price_cents=120_000,
        reference_price_cents=300_000,
        reference_note="ignorada",
    )

    items = _items(api)

    assert items["SSD"]["reference"] == {
        "price_cents": 50_000,
        "note": "média do Google Shopping",
        "saving_cents": 10_000,
        "pct": 20.0,
    }
    assert items["SSD"]["savings"] is None
    # With a teleyes history the typed reference is ignored: only what the app saw counts.
    assert items["Placa"]["reference"] is None
    assert items["Placa"]["savings"]["saving_vs_median_cents"] == 30_000


def test_totals_keep_teleyes_and_reference_savings_apart(api: ApiContext) -> None:
    _add_prices(api, [1_500, 1_600, 1_400])
    _post(api, name="Placa", product_key=KEY, price_cents=120_000)
    _post(api, name="SSD", price_cents=40_000, reference_price_cents=50_000)
    _post(api, name="RAM", price_cents=60_000, reference_price_cents=55_000)  # paid above
    _post(api, name="Cabo", price_cents=3_000)

    report = api.client.get("/savings/report").json()
    totals = report["totals"]

    assert totals["estimated_saving_cents"] == 30_000
    assert totals["linked_with_data"] == 1
    assert totals["reference_saving_cents"] == 5_000
    assert totals["reference_purchases"] == 2
    assert totals["total_paid_cents"] == 223_000
    assert totals["reference_total_cents"] == 150_000  # teleyes medians only


def test_goal_progress_ignores_references(api: ApiContext) -> None:
    headers = {"x-csrf-token": _login_csrf(api)}
    api.client.put(
        "/savings/goal",
        json={"amount_cents": 100_000, "deadline": "2026-12-31"},
        headers=headers,
    )
    _post(api, name="SSD", price_cents=40_000, reference_price_cents=90_000)

    goal = api.client.get("/savings/report").json()["goal"]

    assert goal["saved_cents"] == 0


def test_reference_validation_and_note_without_price(api: ApiContext) -> None:
    headers = {"x-csrf-token": _login_csrf(api)}

    def post(**fields: Any) -> int:
        return api.client.post("/purchases", json=_body(**fields), headers=headers).status_code

    assert post(reference_price_cents=0) == 422
    assert post(reference_price_cents=-5) == 422
    assert post(reference_price_cents=500, reference_note="x" * 121) == 422
    created = _post(api, reference_note="só nota")
    assert created["reference_price_cents"] is None
    assert created["reference_note"] is None
    ok = _post(api, name="Com ref", reference_price_cents=500, reference_note="  média   web ")
    assert ok["reference_note"] == "média web"

    update = api.client.put(
        f"/purchases/{ok['id']}",
        json=_body(name="Com ref", reference_price_cents=None),
        headers={"x-csrf-token": _login_csrf(api)},
    )
    assert update.status_code == 200, update.text
    assert update.json()["reference_price_cents"] is None
    assert update.json()["reference_note"] is None


def test_pure_helpers() -> None:
    ref = reference_saving(40_000, 50_000)
    assert (ref.saving_cents, ref.pct) == (10_000, 20.0)
    assert reference_saving(60_000, 50_000).saving_cents == -10_000
    assert uses_reference(None) is True


def test_migration_adds_and_removes_the_reference_columns(
    db_path: Path, alembic_runner: AlembicRunner
) -> None:
    url = f"sqlite:///{db_path}"

    def columns() -> set[str]:
        with get_engine(url).connect() as connection:
            rows = connection.exec_driver_sql("PRAGMA table_info(purchase)").fetchall()
        return {row[1] for row in rows}

    assert alembic_runner("upgrade", PREVIOUS_HEAD, database_url=url).returncode == 0
    assert "reference_price_cents" not in columns()
    with get_engine(url).begin() as connection:
        connection.exec_driver_sql(
            "INSERT INTO purchase (name, price_cents, purchased_at, created_at) "
            "VALUES ('Antiga', 1000, '2026-10-01 00:00:00', '2026-10-01 00:00:00')"
        )

    up = alembic_runner("upgrade", "a7d4b2e91c35", database_url=url)
    assert up.returncode == 0, up.stderr
    assert {"reference_price_cents", "reference_note"} <= columns()
    with get_engine(url).connect() as connection:
        row = connection.exec_driver_sql(
            "SELECT reference_price_cents, reference_note FROM purchase"
        ).fetchone()
    assert row is not None
    assert tuple(row) == (None, None)  # existing rows are untouched
    rejected = False
    try:
        with get_engine(url).begin() as connection:
            connection.exec_driver_sql("UPDATE purchase SET reference_price_cents = 0")
    except Exception:  # the CHECK constraint
        rejected = True
    assert rejected

    down = alembic_runner("downgrade", PREVIOUS_HEAD, database_url=url)
    assert down.returncode == 0, down.stderr
    assert "reference_price_cents" not in columns()
    assert "reference_note" not in columns()


def test_model_has_the_new_columns(api: ApiContext) -> None:
    _post(api, reference_price_cents=700)
    with api.session_factory() as session:
        stored = session.scalars(select(Purchase)).one()
    assert stored.reference_price_cents == 700
    assert NOW - stored.purchased_at.replace(tzinfo=NOW.tzinfo) < timedelta(days=3)
