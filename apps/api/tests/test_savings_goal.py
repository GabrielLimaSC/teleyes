# ruff: noqa: F811
"""S21-08: savings goal CRUD, progress/pace in `GET /savings/report`, `share_of_goal`."""

from datetime import UTC, date, datetime
from typing import Any

import pytest
from tests.test_purchases_api import KEY, _add_prices, _body
from tests.test_snoozes_api import ApiContext, _login_csrf, api  # noqa: F401

from app.main import app
from app.savings import goal_progress
from app.utc import utc_now

DEADLINE = date(2026, 12, 2)  # 70 days after NOW (2026-09-23)


def _put(api: ApiContext, **overrides: Any) -> Any:
    body = {"amount_cents": 100_000, "deadline": DEADLINE.isoformat()}
    body.update(overrides)
    return api.client.put("/savings/goal", json=body, headers={"x-csrf-token": _login_csrf(api)})


def test_goal_is_null_until_set_then_put_get_delete(api: ApiContext) -> None:
    _login_csrf(api)
    assert api.client.get("/savings/goal").json() is None
    assert api.client.get("/savings/report").json()["goal"] is None

    created = _put(api)
    assert created.status_code == 200
    assert created.json()["amount_cents"] == 100_000
    assert created.json()["deadline"] == "2026-12-02"

    updated = _put(api, amount_cents=250_000)
    assert updated.json()["amount_cents"] == 250_000
    assert updated.json()["created_at"] == created.json()["created_at"]
    assert api.client.get("/savings/goal").json()["amount_cents"] == 250_000

    headers = {"x-csrf-token": _login_csrf(api)}
    assert api.client.delete("/savings/goal", headers=headers).status_code == 204
    assert api.client.get("/savings/goal").json() is None
    assert api.client.delete("/savings/goal", headers=headers).status_code == 204


def test_goal_validation_and_csrf(api: ApiContext) -> None:
    assert _put(api, amount_cents=0).status_code == 422
    assert _put(api, amount_cents=-5).status_code == 422
    assert _put(api, deadline="2026-09-23").status_code == 422  # today is not the future
    assert _put(api, deadline="2026-01-01").status_code == 422
    body = {"amount_cents": 1, "deadline": "2026-12-02"}
    assert api.client.put("/savings/goal", json=body).status_code == 403
    assert api.client.delete("/savings/goal").status_code == 403


def test_report_goal_progress_uses_the_estimated_saving(api: ApiContext) -> None:
    _add_prices(api, [1_500, 1_600, 1_400, 1_700])
    headers = {"x-csrf-token": _login_csrf(api)}
    api.client.post("/purchases", json=_body(product_key=KEY, price_cents=120_000), headers=headers)
    api.client.post("/purchases", json=_body(name="Cabo", price_cents=3_000), headers=headers)
    _put(api, amount_cents=100_000)

    report = api.client.get("/savings/report").json()

    goal = report["goal"]
    assert goal["saved_cents"] == report["totals"]["estimated_saving_cents"] == 35_000
    assert goal["pct"] == 35.0
    assert goal["remaining_cents"] == 65_000
    assert goal["days_left"] == 70
    assert goal["pace"] == "on_track"  # 35% saved, 0% of the time elapsed
    linked = next(i for i in report["items"] if i["linked"])
    loose = next(i for i in report["items"] if not i["linked"])
    assert linked["share_of_goal"] == 35.0
    assert loose["share_of_goal"] is None


def test_share_of_goal_is_negative_when_overpaid_and_null_without_goal(api: ApiContext) -> None:
    _add_prices(api, [1_500, 1_600, 1_400, 1_700])
    headers = {"x-csrf-token": _login_csrf(api)}
    api.client.post("/purchases", json=_body(product_key=KEY, price_cents=200_000), headers=headers)

    assert api.client.get("/savings/report").json()["items"][0]["share_of_goal"] is None

    _put(api, amount_cents=100_000)
    report = api.client.get("/savings/report").json()
    assert report["items"][0]["share_of_goal"] == -45.0
    assert report["goal"]["saved_cents"] == -45_000
    assert report["goal"]["pct"] == -45.0
    assert report["goal"]["remaining_cents"] == 145_000
    assert report["goal"]["pace"] == "behind"


def test_expired_goal_reported_through_the_api(api: ApiContext) -> None:
    _put(api)
    app.dependency_overrides[utc_now] = lambda: datetime(2026, 12, 5, 15, tzinfo=UTC)

    goal = api.client.get("/savings/report").json()["goal"]

    assert goal["pace"] == "expired"
    assert goal["days_left"] == 0
    assert goal["remaining_cents"] == 100_000


START = date(2026, 1, 1)
END = date(2026, 1, 11)  # 10 days


@pytest.mark.parametrize(
    ("today", "saved", "pace"),
    [
        (date(2026, 1, 6), 100_000, "done"),  # reached early
        (date(2026, 3, 1), 100_000, "done"),  # reached after the deadline still counts
        (date(2026, 1, 6), 50_000, "on_track"),  # 50% saved at 50% of the time
        (date(2026, 1, 6), 49_000, "behind"),
        (date(2026, 1, 1), 0, "on_track"),  # nothing elapsed yet
        (date(2026, 1, 12), 90_000, "expired"),
        (date(2026, 1, 6), -10_000, "behind"),
    ],
)
def test_goal_pace(today: date, saved: int, pace: str) -> None:
    result = goal_progress(
        amount_cents=100_000, deadline=END, start=START, today=today, saved_cents=saved
    )

    assert result.pace == pace
    assert result.remaining_cents == max(100_000 - saved, 0)
    assert result.saved_cents == saved
