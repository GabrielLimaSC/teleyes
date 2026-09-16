import itertools
import time
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, create_engine, event
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.main import app
from app.routers.notifications import BotNotifierFactory, get_bot_notifier_factory
from auth.hashing import hash_password
from auth.rate_limit import LoginRateLimiter
from auth.session import SessionStore
from models import Admin, Delivery, Match, Recipient, Rule, Source
from models.base import Base
from packages.metrics.counters import MetricReason, increment_counter
from packages.notifications.bot import BotNotifier
from packages.notifications.fakes import FakeBotClient
from packages.telegram.adapter import AdapterState, TelegramAdapter
from packages.telegram.fakes import FakeTelegramClient

PASSWORD = "correct horse battery staple"


@dataclass
class ApiContext:
    client: TestClient
    engine: Engine
    session_factory: sessionmaker[Session]


@pytest.fixture
def api() -> Iterator[ApiContext]:
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    test_sessionmaker = sessionmaker(bind=engine, expire_on_commit=False)

    with test_sessionmaker() as setup_session:
        setup_session.add(Admin(password_hash=hash_password(PASSWORD)))
        setup_session.commit()

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
            api_id=None,
            api_hash=None,
            client=FakeTelegramClient(),
            sleep=_no_sleep,
        )
        app.state.bot_configured = False
        app.state.notification_test_ids = itertools.count(start=-1, step=-1)
        app.dependency_overrides.clear()

        with TestClient(app, base_url="https://testserver") as client:
            yield ApiContext(client=client, engine=engine, session_factory=test_sessionmaker)
    finally:
        app.dependency_overrides.clear()
        app.dependency_overrides.update(previous_overrides)
        for name, value in previous_state.items():
            setattr(app.state, name, value)
        engine.dispose()


async def _no_sleep(delay: float) -> None:
    return None


def _login(api: ApiContext) -> str:
    response = api.client.post("/auth/login", json={"password": PASSWORD})
    assert response.status_code == 200
    return response.json()["csrf_token"]


def _seed_matches(api: ApiContext) -> dict[str, int]:
    now = datetime.now(UTC)
    with api.session_factory() as session:
        source_a = Source(name="Grupo A", telegram_chat_id="-1001")
        source_b = Source(name="Grupo B", telegram_chat_id="-1002")
        rule_a = Rule(name="Notebooks", include_terms="notebook")
        rule_b = Rule(name="Celulares", include_terms="celular")
        recipient_a = Recipient(
            name="Gabriel", telegram_chat_id="101", active=True, allowlisted=True
        )
        recipient_b = Recipient(
            name="Destinatária", telegram_chat_id="202", active=True, allowlisted=True
        )
        session.add_all([source_a, source_b, rule_a, rule_b, recipient_a, recipient_b])
        session.flush()

        match_a = Match(
            source_id=source_a.id,
            rule_id=rule_a.id,
            message_text="Notebook por R$ 100,00",
            price_cents=10_000,
            message_link="https://t.me/grupo/1",
            matched_at=now,
        )
        match_b = Match(
            source_id=source_b.id,
            rule_id=rule_a.id,
            message_text="Notebook por R$ 250,00",
            price_cents=25_000,
            matched_at=now,
        )
        match_c = Match(
            source_id=source_a.id,
            rule_id=rule_b.id,
            message_text="Celular sem preço informado",
            price_cents=None,
            matched_at=now,
        )
        session.add_all([match_a, match_b, match_c])
        session.flush()
        session.add_all(
            [
                Delivery(
                    match_id=match_a.id,
                    recipient_id=recipient_a.id,
                    status="sent",
                    delivered_at=now,
                ),
                Delivery(
                    match_id=match_a.id,
                    recipient_id=recipient_b.id,
                    status="failed",
                ),
                Delivery(
                    match_id=match_b.id,
                    recipient_id=recipient_b.id,
                    status="pending",
                ),
            ]
        )
        session.commit()
        return {
            "source_a": source_a.id,
            "source_b": source_b.id,
            "rule_a": rule_a.id,
            "rule_b": rule_b.id,
            "recipient_a": recipient_a.id,
            "recipient_b": recipient_b.id,
            "match_a": match_a.id,
            "match_b": match_b.id,
            "match_c": match_c.id,
        }


def _response_ids(response_data: list[dict[str, object]]) -> set[int]:
    result: set[int] = set()
    for item in response_data:
        match_id = item["id"]
        assert isinstance(match_id, int)
        result.add(match_id)
    return result


def test_observability_routes_enforce_auth_and_notification_enforces_csrf(
    api: ApiContext,
) -> None:
    assert api.client.get("/matches").status_code == 401
    assert api.client.get("/metrics").status_code == 401
    assert (
        api.client.post(
            "/notifications/test", json={"chat_id": "101", "text": "Teste"}
        ).status_code
        == 401
    )

    _login(api)
    without_csrf = api.client.post(
        "/notifications/test", json={"chat_id": "101", "text": "Teste"}
    )
    wrong_csrf = api.client.post(
        "/notifications/test",
        json={"chat_id": "101", "text": "Teste"},
        headers={"x-csrf-token": "wrong"},
    )

    assert without_csrf.status_code == 403
    assert wrong_csrf.status_code == 403


def test_matches_list_includes_deliveries_without_n_plus_one(api: ApiContext) -> None:
    ids = _seed_matches(api)
    _login(api)
    statements: list[str] = []

    def capture_statement(
        connection: object,
        cursor: object,
        statement: str,
        parameters: object,
        context: object,
        executemany: bool,
    ) -> None:
        statements.append(statement)

    event.listen(api.engine, "before_cursor_execute", capture_statement)
    try:
        response = api.client.get("/matches")
    finally:
        event.remove(api.engine, "before_cursor_execute", capture_statement)

    assert response.status_code == 200
    assert len(statements) == 1
    assert len(response.json()) == 3
    assert _response_ids(response.json()) == {
        ids["match_a"],
        ids["match_b"],
        ids["match_c"],
    }
    match_a = next(item for item in response.json() if item["id"] == ids["match_a"])
    assert {delivery["status"] for delivery in match_a["deliveries"]} == {"sent", "failed"}
    match_c = next(item for item in response.json() if item["id"] == ids["match_c"])
    assert match_c["deliveries"] == []


def test_every_match_filter_and_price_range(api: ApiContext) -> None:
    ids = _seed_matches(api)
    _login(api)
    cases = [
        ({"rule_id": ids["rule_a"]}, {ids["match_a"], ids["match_b"]}),
        ({"source_id": ids["source_a"]}, {ids["match_a"], ids["match_c"]}),
        ({"recipient_id": ids["recipient_b"]}, {ids["match_a"], ids["match_b"]}),
        ({"price_cents": 10_000}, {ids["match_a"]}),
        ({"min_price_cents": 15_000}, {ids["match_b"]}),
        ({"max_price_cents": 15_000}, {ids["match_a"]}),
        ({"min_price_cents": 10_000, "max_price_cents": 25_000}, {ids["match_a"], ids["match_b"]}),
        ({"delivery_status": "sent"}, {ids["match_a"]}),
        (
            {"recipient_id": ids["recipient_b"], "delivery_status": "sent"},
            set(),
        ),
        (
            {"recipient_id": ids["recipient_a"], "delivery_status": "sent"},
            {ids["match_a"]},
        ),
    ]

    for query, expected_ids in cases:
        response = api.client.get("/matches", params=query)
        assert response.status_code == 200
        assert _response_ids(response.json()) == expected_ids


def test_invalid_match_price_range_becomes_422(api: ApiContext) -> None:
    _login(api)

    response = api.client.get(
        "/matches", params={"min_price_cents": 20_000, "max_price_cents": 10_000}
    )

    assert response.status_code == 422


def test_matches_sort_by_price_puts_nulls_last_regardless_of_direction(
    api: ApiContext,
) -> None:
    """S7-07: match_a=10_000, match_b=25_000, match_c=None (see _seed_matches)."""
    ids = _seed_matches(api)
    _login(api)

    def ordered_ids(sort: str) -> list[int]:
        response = api.client.get("/matches", params={"sort": sort})
        assert response.status_code == 200
        return [item["id"] for item in response.json()]

    assert ordered_ids("price_asc") == [ids["match_a"], ids["match_b"], ids["match_c"]]
    assert ordered_ids("price_desc") == [ids["match_b"], ids["match_a"], ids["match_c"]]


def test_matches_sort_defaults_to_recency_and_rejects_unknown_values(
    api: ApiContext,
) -> None:
    ids = _seed_matches(api)
    _login(api)

    default_response = api.client.get("/matches")
    assert default_response.status_code == 200
    # All three share the same `matched_at` in `_seed_matches` — this order
    # comes from the `Match.id.desc()` *tiebreaker* (S10-03), not from
    # `matched_at` itself, which ties here and proves nothing about recency
    # order on its own — see the dedicated out-of-order test below for that.
    assert [item["id"] for item in default_response.json()] == [
        ids["match_c"],
        ids["match_b"],
        ids["match_a"],
    ]

    invalid_response = api.client.get("/matches", params={"sort": "price"})
    assert invalid_response.status_code == 422


def test_matches_default_order_is_real_chronological_order_not_insertion_order(
    api: ApiContext,
) -> None:
    """S10-03: real production regression — a historical re-scan (S6-02)
    inserts matches for old messages out of order every time the listener
    restarts, so `Match.id.desc()` alone (insertion order) quietly stopped
    tracking real recency. Confirmed against production data: zero
    correlation between `id` and `matched_at` after a few restarts.

    Seeds three matches whose *insertion* order is scrambled relative to
    their `matched_at` order, mirroring the real production shape (a recent
    real-time match inserted first, gets the lowest id; an old historical
    match inserted after it, gets a higher id despite being older).
    """
    now = datetime.now(UTC)
    with api.session_factory() as session:
        source = Source(name="Grupo S10-03", telegram_chat_id="-1010")
        rule = Rule(name="Regra S10-03", include_terms="produto")
        session.add_all([source, rule])
        session.flush()

        def make(text: str, matched_at: datetime) -> Match:
            match = Match(
                source_id=source.id,
                rule_id=rule.id,
                message_text=text,
                price_cents=10_000,
                matched_at=matched_at,
            )
            session.add(match)
            session.flush()
            return match

        # Insertion order: recent, old, middle — deliberately not sorted
        # either way, so a passing test can't be an accident of coincidence.
        recent = make("Produto recente", now)
        old = make("Produto antigo", now - timedelta(days=7))
        middle = make("Produto do meio", now - timedelta(days=1))
        session.commit()
        ids = {"recent": recent.id, "old": old.id, "middle": middle.id}

    # Insertion order (= what `id.desc()` alone would return, the bug):
    # middle, old, recent — the exact opposite of real chronological order.
    assert ids["recent"] < ids["old"] < ids["middle"]

    _login(api)
    response = api.client.get("/matches")
    assert response.status_code == 200
    assert [item["id"] for item in response.json()] == [
        ids["recent"],
        ids["middle"],
        ids["old"],
    ]


def test_matches_id_breaks_ties_when_matched_at_is_identical(api: ApiContext) -> None:
    """S10-03: real production example — two different messages processed in
    the same historical-scan batch can share the exact same `matched_at`.
    `Match.id.desc()` is still the final tiebreaker in that case, same as
    before this task.
    """
    now = datetime.now(UTC)
    with api.session_factory() as session:
        source = Source(name="Grupo Tie S10-03", telegram_chat_id="-1011")
        rule = Rule(name="Regra Tie S10-03", include_terms="produto")
        session.add_all([source, rule])
        session.flush()

        first = Match(
            source_id=source.id,
            rule_id=rule.id,
            message_text="Produto A",
            price_cents=10_000,
            matched_at=now,
        )
        session.add(first)
        session.flush()
        second = Match(
            source_id=source.id,
            rule_id=rule.id,
            message_text="Produto B",
            price_cents=20_000,
            matched_at=now,
        )
        session.add(second)
        session.commit()
        ids = {"first": first.id, "second": second.id}

    _login(api)
    response = api.client.get("/matches")
    assert response.status_code == 200
    assert [item["id"] for item in response.json()] == [ids["second"], ids["first"]]


def test_matches_flag_the_true_historical_lowest_price_per_rule(api: ApiContext) -> None:
    """S7-06: match_a=10_000 is rule_a's minimum, match_b=25_000 is not,
    match_c has no price at all so it can never be flagged.
    """
    ids = _seed_matches(api)
    _login(api)

    response = api.client.get("/matches")
    assert response.status_code == 200
    by_id = {item["id"]: item for item in response.json()}

    assert by_id[ids["match_a"]]["is_lowest_price_ever"] is True
    assert by_id[ids["match_b"]]["is_lowest_price_ever"] is False
    assert by_id[ids["match_c"]]["is_lowest_price_ever"] is False


def test_matches_tied_at_the_lowest_price_are_both_flagged(api: ApiContext) -> None:
    ids = _seed_matches(api)
    with api.session_factory() as session:
        tie = Match(
            source_id=ids["source_a"],
            rule_id=ids["rule_a"],
            message_text="Notebook por R$ 100,00 de novo",
            price_cents=10_000,
            # Far outside GROUPING_WINDOW (S7-11) from match_a's own
            # matched_at, on purpose: this test is about `is_lowest_price_ever`
            # (a rule-wide historical minimum, unrelated to the grouping
            # window), so the tie must stay its own separate card rather than
            # collapsing into match_a's read-time display group.
            matched_at=datetime.now(UTC) + timedelta(days=1),
        )
        session.add(tie)
        session.commit()
        tie_id = tie.id
    _login(api)

    response = api.client.get("/matches", params={"rule_id": ids["rule_a"]})
    assert response.status_code == 200
    by_id = {item["id"]: item for item in response.json()}

    assert by_id[ids["match_a"]]["is_lowest_price_ever"] is True
    assert by_id[tie_id]["is_lowest_price_ever"] is True
    assert by_id[ids["match_b"]]["is_lowest_price_ever"] is False


def test_matches_lowest_price_stays_correct_for_a_match_inserted_out_of_chronological_order(
    api: ApiContext,
) -> None:
    """S7-06: a historical scan (S6-02) processes a source newest-to-oldest,
    so an even cheaper *older* match can be inserted after a newer, pricier
    one already exists. Computed fresh on every read (never persisted at
    insert time), this stays correct regardless of insertion order — no
    backfill of a stale flag on older matches is ever needed.
    """
    ids = _seed_matches(api)
    _login(api)

    before = api.client.get("/matches", params={"rule_id": ids["rule_a"]})
    assert {item["id"]: item["is_lowest_price_ever"] for item in before.json()} == {
        ids["match_a"]: True,
        ids["match_b"]: False,
    }

    with api.session_factory() as session:
        cheaper_but_inserted_later = Match(
            source_id=ids["source_a"],
            rule_id=ids["rule_a"],
            message_text="Notebook por R$ 50,00 (histórico)",
            price_cents=5_000,
            matched_at=datetime.now(UTC) - timedelta(days=2),
        )
        session.add(cheaper_but_inserted_later)
        session.commit()
        cheaper_id = cheaper_but_inserted_later.id

    after = api.client.get("/matches", params={"rule_id": ids["rule_a"]})
    after_flags = {item["id"]: item["is_lowest_price_ever"] for item in after.json()}
    assert after_flags[cheaper_id] is True
    assert after_flags[ids["match_a"]] is False


def test_matches_group_same_rule_and_price_within_window_into_one_card(
    api: ApiContext,
) -> None:
    """S7-11 mechanism 2: three sources post the exact same rule+price, each
    5 minutes after the previous one (well within GROUPING_WINDOW). Only the
    earliest survives as its own card; the other two collapse into its
    `grouped_source_ids`, with no duplicate source id even if two of them
    shared a source.
    """
    ids = _seed_matches(api)
    now = datetime.now(UTC)
    with api.session_factory() as session:
        source_c = Source(name="Grupo C", telegram_chat_id="-1003")
        session.add(source_c)
        session.flush()
        second = Match(
            source_id=ids["source_b"],
            rule_id=ids["rule_a"],
            message_text="Notebook por R$ 100,00 também",
            price_cents=10_000,
            matched_at=now + timedelta(minutes=5),
        )
        third = Match(
            source_id=source_c.id,
            rule_id=ids["rule_a"],
            message_text="Notebook por R$ 100,00 de novo também",
            price_cents=10_000,
            matched_at=now + timedelta(minutes=10),
        )
        session.add_all([second, third])
        session.commit()
    _login(api)

    response = api.client.get("/matches", params={"rule_id": ids["rule_a"]})
    assert response.status_code == 200
    payload = response.json()
    by_id = {item["id"]: item for item in payload}

    # match_b has a different price (25_000) — it is never part of this
    # group and keeps its own card.
    assert set(by_id) == {ids["match_a"], ids["match_b"]}
    assert set(by_id[ids["match_a"]]["grouped_source_ids"]) == {ids["source_b"], source_c.id}
    assert by_id[ids["match_b"]]["grouped_source_ids"] is None


def test_matches_grouping_survives_out_of_chronological_insertion_order(
    api: ApiContext,
) -> None:
    """A historical scan (S6-02) processes newest-to-oldest, so the
    chronologically-earliest match of a group can be the *last* one inserted.
    Grouping is computed fresh from `matched_at` on every read, never from
    insertion order, so the representative is still correctly the earliest
    by time regardless of which row exists in the database first. None of
    these matches ever sent a real alert (no `Delivery` at all), so this
    stays a pure insertion-order check, independent of the representative's
    separate preference for a real "sent" alert (see the dedicated test for
    that).
    """
    ids = _seed_matches(api)
    now = datetime.now(UTC)
    with api.session_factory() as session:
        # A dedicated rule, never rule_a: _seed_matches' own match_a already
        # has a real "sent" delivery at essentially this same `now`, which
        # would otherwise make it the representative regardless of order.
        rule = Rule(name="Regra E2E Ordem Cronológica", include_terms="gadgetordeme2e")
        source_c = Source(name="Grupo E2E Ordem C", telegram_chat_id="-1006")
        session.add_all([rule, source_c])
        session.flush()

        newer_but_inserted_first = Match(
            source_id=source_c.id,
            rule_id=rule.id,
            message_text="gadgetordeme2e por R$ 100,00 também",
            price_cents=10_000,
            matched_at=now + timedelta(minutes=5),
        )
        session.add(newer_but_inserted_first)
        session.commit()

        older_but_inserted_last = Match(
            source_id=ids["source_a"],
            rule_id=rule.id,
            message_text="gadgetordeme2e por R$ 100,00, achado no histórico",
            price_cents=10_000,
            matched_at=now - timedelta(minutes=5),
        )
        session.add(older_but_inserted_last)
        session.commit()
        rule_id, older_id = rule.id, older_but_inserted_last.id
        newer_id = newer_but_inserted_first.id
    _login(api)

    response = api.client.get("/matches", params={"rule_id": rule_id})
    assert response.status_code == 200
    payload = response.json()

    # The true chronological earliest is older_but_inserted_last, even
    # though it was the last row inserted into the database.
    representative = next(item for item in payload if item["id"] == older_id)
    assert representative["grouped_source_ids"] == [source_c.id]
    returned_ids = {item["id"] for item in payload}
    assert older_id in returned_ids
    assert newer_id not in returned_ids


def test_matches_outside_the_grouping_window_stay_separate_cards(api: ApiContext) -> None:
    ids = _seed_matches(api)
    now = datetime.now(UTC)
    with api.session_factory() as session:
        far_apart = Match(
            source_id=ids["source_b"],
            rule_id=ids["rule_a"],
            message_text="Notebook por R$ 100,00, bem depois",
            price_cents=10_000,
            matched_at=now + timedelta(hours=6),
        )
        session.add(far_apart)
        session.commit()
        far_apart_id = far_apart.id
    _login(api)

    response = api.client.get("/matches", params={"rule_id": ids["rule_a"]})
    assert response.status_code == 200
    payload = response.json()

    returned_ids = {item["id"] for item in payload}
    assert far_apart_id in returned_ids
    assert ids["match_a"] in returned_ids
    for item in payload:
        assert item["grouped_source_ids"] is None


def test_matches_group_representative_prefers_a_real_sent_alert_over_being_chronologically_first(
    api: ApiContext,
) -> None:
    """A historical scan (S6-02) can insert an older, `historical`-status
    match for a rule+price shortly before a genuinely new live message from
    a different source triggers a real `sent` alert for the same rule+price,
    within GROUPING_WINDOW of each other. The `historical` match is
    chronologically earlier, but it never really alerted — picking it as the
    representative would show a dishonest status (e.g. "Histórico — sem
    alerta") for a group that did send a real alert, hiding the `sent`
    match entirely. The representative must be the one that actually sent.
    """
    ids = _seed_matches(api)
    now = datetime.now(UTC)
    with api.session_factory() as session:
        # A dedicated rule/sources, never rule_a/source_a/source_b: _seed_matches'
        # own match_a shares rule_a, price 10_000 and a matched_at essentially
        # equal to this test's own `now`, which would otherwise fold into the
        # very chain this test is trying to isolate.
        rule = Rule(name="Regra E2E Histórico vs Sent", include_terms="gadgethistsente2e")
        historical_source = Source(name="Grupo E2E Histórico", telegram_chat_id="-1004")
        sent_source = Source(name="Grupo E2E Sent", telegram_chat_id="-1005")
        session.add_all([rule, historical_source, sent_source])
        session.flush()

        historical_match = Match(
            source_id=historical_source.id,
            rule_id=rule.id,
            message_text="gadgethistsente2e por R$ 100,00, achado no histórico",
            price_cents=10_000,
            matched_at=now - timedelta(minutes=10),
        )
        session.add(historical_match)
        session.flush()
        session.add(
            Delivery(
                match_id=historical_match.id,
                recipient_id=ids["recipient_a"],
                status="historical",
            )
        )

        sent_match = Match(
            source_id=sent_source.id,
            rule_id=rule.id,
            message_text="gadgethistsente2e por R$ 100,00, alerta real",
            price_cents=10_000,
            matched_at=now,
        )
        session.add(sent_match)
        session.flush()
        session.add(
            Delivery(
                match_id=sent_match.id,
                recipient_id=ids["recipient_a"],
                status="sent",
                delivered_at=now,
            )
        )
        session.commit()
        rule_id = rule.id
        historical_id, sent_id = historical_match.id, sent_match.id
    _login(api)

    response = api.client.get("/matches", params={"rule_id": rule_id})
    assert response.status_code == 200
    payload = response.json()
    returned_ids = {item["id"] for item in payload}

    assert sent_id in returned_ids
    assert historical_id not in returned_ids

    representative = next(item for item in payload if item["id"] == sent_id)
    assert {delivery["status"] for delivery in representative["deliveries"]} == {"sent"}
    assert representative["grouped_source_ids"] == [historical_source.id]


def test_rules_expose_the_true_lowest_price_seen_per_rule(api: ApiContext) -> None:
    """S7-06: rule_a's own lowest is match_a's 10_000; rule_b only has
    match_c, which has no extracted price at all, so its lowest stays
    `None` ("—" in the UI) same as a rule with zero matches whatsoever.
    """
    ids = _seed_matches(api)
    with api.session_factory() as session:
        empty_rule = Rule(name="Sem match nenhum", include_terms="nada-e2e")
        session.add(empty_rule)
        session.commit()
        empty_rule_id = empty_rule.id
    _login(api)

    response = api.client.get("/rules?include_inactive=true")
    assert response.status_code == 200
    by_id = {rule["id"]: rule for rule in response.json()}

    assert by_id[ids["rule_a"]]["lowest_price_cents"] == 10_000
    assert by_id[ids["rule_b"]]["lowest_price_cents"] is None
    assert by_id[empty_rule_id]["lowest_price_cents"] is None


def test_rules_lowest_price_recalculates_without_reprocessing_old_matches(
    api: ApiContext,
) -> None:
    ids = _seed_matches(api)
    _login(api)

    before = api.client.get("/rules")
    before_by_id = {rule["id"]: rule for rule in before.json()}
    assert before_by_id[ids["rule_a"]]["lowest_price_cents"] == 10_000

    with api.session_factory() as session:
        cheaper = Match(
            source_id=ids["source_a"],
            rule_id=ids["rule_a"],
            message_text="Notebook por R$ 20,00",
            price_cents=2_000,
            matched_at=datetime.now(UTC),
        )
        session.add(cheaper)
        session.commit()

    after = api.client.get("/rules")
    after_by_id = {rule["id"]: rule for rule in after.json()}
    assert after_by_id[ids["rule_a"]]["lowest_price_cents"] == 2_000


def test_metrics_are_authenticated_and_contain_only_aggregates(api: ApiContext) -> None:
    with api.session_factory() as session:
        source = Source(name="Grupo", telegram_chat_id="-1009")
        session.add(source)
        session.flush()
        increment_counter(session, MetricReason.SEEN, source_id=source.id)
        increment_counter(session, MetricReason.SEEN, source_id=source.id)
        increment_counter(session, MetricReason.BLOCKED, source_id=source.id)
        session.commit()
    _login(api)

    response = api.client.get("/metrics")

    assert response.status_code == 200
    assert response.json() == [
        {
            "source_id": source.id,
            "reason": MetricReason.BLOCKED.value,
            "count": 1,
            "updated_at": response.json()[0]["updated_at"],
        },
        {
            "source_id": source.id,
            "reason": MetricReason.SEEN.value,
            "count": 2,
            "updated_at": response.json()[1]["updated_at"],
        },
    ]
    assert "CONTEUDO REJEITADO NAO PODE APARECER" not in response.text
    assert all(
        set(item) == {"source_id", "reason", "count", "updated_at"}
        for item in response.json()
    )


def test_health_remains_public_and_reports_not_configured_components(api: ApiContext) -> None:
    response = api.client.get("/health")

    assert response.status_code == 200
    assert response.json()["status"] == "ok"
    assert response.json()["env"]
    assert response.json()["version"] == "0.1.0"
    assert response.json()["uptime_seconds"] >= 5.0
    assert response.json()["telegram"] == {
        "configured": False,
        "state": AdapterState.NOT_CONFIGURED.value,
    }
    assert response.json()["bot"] == {"configured": False, "state": "not_configured"}


@pytest.mark.parametrize(
    "adapter_state",
    [
        AdapterState.CONNECTING,
        AdapterState.CONNECTED,
        AdapterState.RECONNECTING,
        AdapterState.BLOCKED,
    ],
)
def test_health_reports_configured_runtime_states(
    api: ApiContext, adapter_state: AdapterState
) -> None:
    adapter = TelegramAdapter(
        api_id=123,
        api_hash="test-hash",
        client=FakeTelegramClient(),
        sleep=_no_sleep,
    )
    adapter.state = adapter_state
    app.state.telegram_adapter = adapter
    app.state.bot_configured = True

    response = api.client.get("/health")

    assert response.status_code == 200
    assert response.json()["telegram"] == {
        "configured": True,
        "state": adapter_state.value,
    }
    assert response.json()["bot"] == {"configured": True, "state": "configured"}
    assert "test-hash" not in response.text


def _seed_notification_recipients(api: ApiContext) -> None:
    with api.session_factory() as session:
        session.add_all(
            [
                Recipient(
                    name="Permitido",
                    telegram_chat_id="101",
                    active=True,
                    allowlisted=True,
                ),
                Recipient(
                    name="Pausado",
                    telegram_chat_id="202",
                    active=False,
                    allowlisted=True,
                ),
                Recipient(
                    name="Sem allowlist",
                    telegram_chat_id="303",
                    active=True,
                    allowlisted=False,
                ),
            ]
        )
        session.commit()


def _override_notifier(api: ApiContext, fake_client: FakeBotClient, *, configured: bool) -> None:
    def dependency() -> BotNotifierFactory:
        def factory(allowlisted_chat_ids: set[str]) -> BotNotifier:
            return BotNotifier(
                bot_token="test-token" if configured else None,
                client=fake_client,
                allowlisted_chat_ids=allowlisted_chat_ids,
            )

        return factory

    app.dependency_overrides[get_bot_notifier_factory] = dependency


def test_notification_returns_not_configured_without_sending(api: ApiContext) -> None:
    _seed_notification_recipients(api)
    csrf = _login(api)
    fake_client = FakeBotClient()
    _override_notifier(api, fake_client, configured=False)

    response = api.client.post(
        "/notifications/test",
        json={"chat_id": "101", "text": "Teste seguro"},
        headers={"x-csrf-token": csrf},
    )

    assert response.status_code == 200
    assert response.json()["delivered"] is False
    assert response.json()["status"] == "not_configured"
    assert fake_client.sent == []


def test_notification_fake_succeeds_repeatedly_for_allowlisted_recipient(
    api: ApiContext,
) -> None:
    _seed_notification_recipients(api)
    csrf = _login(api)
    fake_client = FakeBotClient()
    _override_notifier(api, fake_client, configured=True)
    headers = {"x-csrf-token": csrf}
    payload = {"chat_id": "101", "text": "Teste seguro"}

    first = api.client.post("/notifications/test", json=payload, headers=headers)
    second = api.client.post("/notifications/test", json=payload, headers=headers)

    assert first.status_code == 200
    assert second.status_code == 200
    assert first.json()["status"] == second.json()["status"] == "sent"
    assert fake_client.sent == [("101", "Teste seguro"), ("101", "Teste seguro")]


@pytest.mark.parametrize(
    ("chat_id", "expected_status"),
    [("999", 404), ("202", 403), ("303", 403)],
)
def test_notification_refuses_unknown_inactive_or_non_allowlisted_recipient(
    api: ApiContext,
    chat_id: str,
    expected_status: int,
) -> None:
    _seed_notification_recipients(api)
    csrf = _login(api)
    fake_client = FakeBotClient()
    _override_notifier(api, fake_client, configured=True)

    response = api.client.post(
        "/notifications/test",
        json={"chat_id": chat_id, "text": "Teste seguro"},
        headers={"x-csrf-token": csrf},
    )

    assert response.status_code == expected_status
    assert fake_client.sent == []


def test_notification_delivery_failure_becomes_502_without_error_leak(
    api: ApiContext,
) -> None:
    _seed_notification_recipients(api)
    csrf = _login(api)
    fake_client = FakeBotClient(fail_for_chat_ids={"101"})
    _override_notifier(api, fake_client, configured=True)

    response = api.client.post(
        "/notifications/test",
        json={"chat_id": "101", "text": "Teste seguro"},
        headers={"x-csrf-token": csrf},
    )

    assert response.status_code == 502
    assert response.json() == {"detail": "notification delivery failed"}
    assert "test-token" not in response.text
