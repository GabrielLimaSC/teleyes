"""S25-F3: cash + card prices and "Reavaliar regras com este preço" on
`PATCH /matches/{id}`.

Hard rule under test: a reevaluation never duplicates an alert — the first
target hit notifies once, and saving again (same or a lower price) sends
nothing new — and saving the same correction twice changes nothing.
"""

from typing import Any

import httpx
import pytest
from sqlalchemy import select
from tests.match_api_support import ApiContext, _add_match, _login_csrf

from models import Delivery, Match, MatchCorrection, Rule


def _patch(api: ApiContext, match_id: int, body: dict[str, Any]) -> httpx.Response:
    return api.client.patch(
        f"/matches/{match_id}", json=body, headers={"x-csrf-token": _login_csrf(api)}
    )


def _set_pair(api: ApiContext, match_id: int, cash: int | None, card: int | None) -> None:
    with api.session_factory() as session:
        match = session.get(Match, match_id)
        assert match is not None
        match.price_cash_cents = cash
        match.price_card_cents = card
        session.commit()


def _match(api: ApiContext, match_id: int) -> Match:
    with api.session_factory() as session:
        match = session.get(Match, match_id)
        assert match is not None
        session.expunge(match)
        return match


def _corrections(api: ApiContext, match_id: int) -> list[MatchCorrection]:
    with api.session_factory() as session:
        return list(
            session.scalars(
                select(MatchCorrection)
                .where(MatchCorrection.match_id == match_id)
                .order_by(MatchCorrection.id)
            )
        )


def _all_deliveries(api: ApiContext, match_id: int) -> list[Delivery]:
    with api.session_factory() as session:
        return list(session.scalars(select(Delivery).where(Delivery.match_id == match_id)))


# --- card price ---------------------------------------------------------


def test_patch_sets_cash_and_card_together_and_audits_every_field(api: ApiContext) -> None:
    match_id = _add_match(api, rule_id=api.ids["rule_no_target"], price_cents=None)

    response = _patch(api, match_id, {"price": "449,90", "price_card": "5.249,90"})

    assert response.status_code == 200
    body = response.json()
    assert body["price_cents"] == 44_990
    assert body["price_cash_cents"] == 44_990
    assert body["price_card_cents"] == 524_990
    assert body["price_source"] == "manual"
    changes = _corrections(api, match_id)[0].changes
    assert changes["price_cents"] == {"before": None, "after": 44_990}
    assert changes["price_cash_cents"] == {"before": None, "after": 44_990}
    assert changes["price_card_cents"] == {"before": None, "after": 524_990}


def test_blank_or_null_card_clears_the_card_price_and_the_pair(api: ApiContext) -> None:
    match_id = _add_match(api, rule_id=api.ids["rule_no_target"], price_cents=44_990)
    _set_pair(api, match_id, 44_990, 52_499)

    cleared = _patch(api, match_id, {"price_card": ""})

    assert cleared.status_code == 200
    assert cleared.json()["price_card_cents"] is None
    assert cleared.json()["price_cash_cents"] is None
    assert cleared.json()["price_cents"] == 44_990  # the cash price itself stays
    assert _corrections(api, match_id)[0].changes["price_card_cents"] == {
        "before": 52_499,
        "after": None,
    }

    _set_pair(api, match_id, 44_990, 52_499)
    assert _patch(api, match_id, {"price_card": None}).json()["price_card_cents"] is None


def test_omitting_price_card_leaves_it_alone_and_cash_follows_the_new_price(
    api: ApiContext,
) -> None:
    match_id = _add_match(api, rule_id=api.ids["rule_no_target"], price_cents=44_990)
    _set_pair(api, match_id, 44_990, 52_499)

    body = _patch(api, match_id, {"price": "429,90"}).json()

    assert body["price_card_cents"] == 52_499
    assert body["price_cash_cents"] == 42_990
    assert body["price_cents"] == 42_990


def test_card_only_edit_does_not_touch_the_cash_price(api: ApiContext) -> None:
    match_id = _add_match(api, rule_id=api.ids["rule_no_target"], price_cents=44_990)

    body = _patch(api, match_id, {"price_card": "500"}).json()

    assert body["price_cents"] == 44_990
    assert body["price_cash_cents"] == 44_990
    assert body["price_card_cents"] == 50_000
    assert body["original_price_cents"] == 44_990


@pytest.mark.parametrize("bad", ["abc", "12,345", "0", "-5", "1.2.3"])
def test_invalid_card_price_is_rejected_and_nothing_is_applied(api: ApiContext, bad: str) -> None:
    match_id = _add_match(api, rule_id=api.ids["rule_no_target"], price_cents=44_990)

    response = _patch(
        api, match_id, {"price": "300", "price_card": bad, "display_name": "Nome novo"}
    )

    assert response.status_code == 422
    match = _match(api, match_id)
    assert match.price_cents == 44_990
    assert match.price_card_cents is None
    assert match.display_name is None
    assert _corrections(api, match_id) == []


def test_invalid_cash_price_is_rejected_with_reevaluate(api: ApiContext) -> None:
    match_id = _add_match(api, price_cents=650_000)

    response = _patch(api, match_id, {"price": "R$ ??", "reevaluate": True})

    assert response.status_code == 422
    assert _match(api, match_id).price_cents == 650_000
    assert _corrections(api, match_id) == []


def test_card_price_without_any_cash_price_is_rejected(api: ApiContext) -> None:
    match_id = _add_match(api, rule_id=api.ids["rule_no_target"], price_cents=None)

    response = _patch(api, match_id, {"price_card": "500"})

    assert response.status_code == 422
    assert _match(api, match_id).price_card_cents is None


def test_revert_restores_the_detected_cash_card_pair(api: ApiContext) -> None:
    match_id = _add_match(api, rule_id=api.ids["rule_no_target"], price_cents=44_990)
    _set_pair(api, match_id, 44_990, 52_499)
    _patch(api, match_id, {"price": "400", "price_card": ""})
    _patch(api, match_id, {"price": "410", "price_card": "480"})

    reverted = api.client.post(
        f"/matches/{match_id}/revert", headers={"x-csrf-token": _login_csrf(api)}
    ).json()

    assert reverted["price_cents"] == 44_990
    assert reverted["price_cash_cents"] == 44_990
    assert reverted["price_card_cents"] == 52_499


def test_revert_drops_a_card_price_that_was_added_by_hand(api: ApiContext) -> None:
    match_id = _add_match(api, rule_id=api.ids["rule_no_target"], price_cents=44_990)
    _patch(api, match_id, {"price_card": "500"})

    reverted = api.client.post(
        f"/matches/{match_id}/revert", headers={"x-csrf-token": _login_csrf(api)}
    ).json()

    assert reverted["price_card_cents"] is None
    assert reverted["price_cash_cents"] is None


# --- reevaluate ---------------------------------------------------------


def test_reevaluate_reaching_the_target_sends_the_first_alert_once(api: ApiContext) -> None:
    match_id = _add_match(api, price_cents=650_000)  # rule target is 560_000

    response = _patch(api, match_id, {"price": "5.500,00", "reevaluate": True})

    assert response.status_code == 200
    body = response.json()
    assert body["price_cents"] == 550_000
    assert body["target_hit"] is True  # status updated on read
    assert len(api.bot_client.sent) == 1
    deliveries = _all_deliveries(api, match_id)
    assert [(d.kind, d.status) for d in deliveries] == [("manual_target", "sent")]


def test_reevaluate_skips_a_recipient_that_already_has_a_pipeline_target_delivery(
    api: ApiContext,
) -> None:
    match_id = _add_match(api, price_cents=650_000)
    with api.session_factory() as session:
        session.add(
            Delivery(
                match_id=match_id,
                recipient_id=api.ids["recipient"],
                kind="target",
                status="sent",
            )
        )
        session.commit()

    _patch(api, match_id, {"price": "5.500,00", "reevaluate": True})

    assert api.bot_client.sent == []
    assert [d.kind for d in _all_deliveries(api, match_id)] == ["target"]


def test_reevaluate_marks_rule_and_target_in_the_audit_row(api: ApiContext) -> None:
    match_id = _add_match(api, price_cents=650_000)

    _patch(api, match_id, {"price": "5.500,00", "reevaluate": True})

    mark = _corrections(api, match_id)[0].changes["reevaluation"]["after"]
    assert mark == {
        "rule_id": api.ids["rule"],
        "target_price_cents": 560_000,
        "target_hit_before": False,
        "target_hit": True,
        "above_max_price": False,
    }


def test_reevaluate_flags_a_price_above_the_rule_ceiling(api: ApiContext) -> None:
    with api.session_factory() as session:
        rule = session.get(Rule, api.ids["rule_no_target"])
        assert rule is not None
        rule.max_price_cents = 500_000
        session.commit()
    match_id = _add_match(api, rule_id=api.ids["rule_no_target"], price_cents=450_000)

    _patch(api, match_id, {"price": "5.500,00", "reevaluate": True})

    mark = _corrections(api, match_id)[0].changes["reevaluation"]["after"]
    assert mark["above_max_price"] is True
    assert mark["target_hit"] is False


def test_reevaluate_saving_again_never_duplicates_the_alert(api: ApiContext) -> None:
    match_id = _add_match(api, price_cents=650_000)
    body = {"price": "5.500,00", "price_card": "5.900,00", "reevaluate": True}

    first = _patch(api, match_id, body)
    second = _patch(api, match_id, body)
    third = _patch(api, match_id, body)

    assert first.status_code == second.status_code == third.status_code == 200
    assert second.json()["price_cents"] == first.json()["price_cents"]
    assert len(_corrections(api, match_id)) == 1
    assert len(api.bot_client.sent) == 1  # the target alert, once, not three times
    assert len(_all_deliveries(api, match_id)) == 1


def test_reevaluate_does_not_resend_after_an_alert_was_already_sent(api: ApiContext) -> None:
    match_id = _add_match(api, price_cents=650_000)
    _patch(api, match_id, {"price": "5.500,00"})  # legacy path: one manual_target alert
    assert len(api.bot_client.sent) == 1
    before = _all_deliveries(api, match_id)

    _patch(api, match_id, {"price": "5.400,00", "reevaluate": True})
    _patch(api, match_id, {"price": "5.300,00", "reevaluate": True})

    assert len(api.bot_client.sent) == 1
    assert [d.id for d in _all_deliveries(api, match_id)] == [d.id for d in before]


def test_without_reevaluate_the_existing_manual_target_alert_is_unchanged(
    api: ApiContext,
) -> None:
    match_id = _add_match(api, price_cents=650_000)

    _patch(api, match_id, {"price": "5.500,00"})

    assert len(api.bot_client.sent) == 1
    assert "reevaluation" not in _corrections(api, match_id)[0].changes


def test_card_only_edit_on_a_match_below_target_does_not_alert(api: ApiContext) -> None:
    match_id = _add_match(api, price_cents=550_000)  # already below the 560_000 target

    _patch(api, match_id, {"price_card": "5.900,00"})

    assert api.bot_client.sent == []
    assert _all_deliveries(api, match_id) == []


def test_reevaluate_updates_the_product_history(api: ApiContext) -> None:
    match_id = _add_match(api, price_cents=650_000)
    _patch(api, match_id, {"price": "5.500,00", "reevaluate": True})

    product_key = _match(api, match_id).product_key
    history = api.client.get(f"/products/{product_key}")

    assert history.status_code == 200
    assert history.json()["current_price_cents"] == 550_000
