"""S21-09 — hourly metrics, service heartbeats and the event log (backend)."""

import asyncio
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import select, text
from sqlalchemy.orm import Session, sessionmaker
from tests.match_api_support import NOW, ApiContext, _add_match

from app.health_sampler import HealthSampler, sample_health
from app.listener_control import ensure_control_row, touch_listener_seen
from app.main import app
from app.pipeline import (
    IncomingMessage,
    process_message,
    target_event_summary,
)
from app.routers.events import _stream
from models import Match, Recipient, Rule, Source
from models.base import Base
from models.db import get_engine
from packages.events.broker import EventBroker
from packages.metrics.hourly import (
    MetricHourly,
    ServiceHeartbeat,
    SystemEvent,
    hour_floor,
)
from packages.telegram.adapter import TelegramAdapter
from packages.telegram.fakes import FakeTelegramClient
from teleyes_core.notifications.bot import BotNotifier
from teleyes_core.notifications.fakes import FakeBotClient
from teleyes_core.rules.dedupe import DedupeCache

HOUR = hour_floor(NOW)
SERVICES = ["telegram", "bot", "listener", "sse", "db"]


def _add_hourly(
    api: ApiContext, hour: datetime, reason: str, count: int, source: str | None = "source"
) -> None:
    with api.session_factory() as session:
        session.add(
            MetricHourly(
                hour_utc=hour,
                source_id=api.ids[source] if source else None,
                reason=reason,
                count=count,
            )
        )
        session.commit()


def _add_heartbeat(api: ApiContext, service: str, hour: datetime, ok: int, total: int) -> None:
    with api.session_factory() as session:
        session.add(ServiceHeartbeat(service=service, hour_utc=hour, ok=ok, total=total))
        session.commit()


# --- GET /health/history -----------------------------------------------------


def test_history_without_data_is_all_null_never_zero_or_ok(api: ApiContext) -> None:
    body = api.client.get("/health/history").json()

    assert body["hours"] == 24
    assert body["coverage_since"] is None
    assert [service["service"] for service in body["services"]] == SERVICES
    for service in body["services"]:
        assert len(service["buckets"]) == 24
        assert all(b["ok"] is None and b["total"] is None for b in service["buckets"])
    collector = body["collector"]
    assert collector["coverage_since"] is None
    assert len(collector["hours"]) == 24
    assert all(h["seen"] is None and h["evaluated"] is None for h in collector["hours"])
    assert collector["totals"] == {
        "seen": 0,
        "discarded": 0,
        "evaluated": 0,
        "delivery_failures": 0,
        "delivery_failures_last_hour": 0,
    }


def test_history_buckets_are_hourly_utc_oldest_first_ending_now(api: ApiContext) -> None:
    buckets = api.client.get("/health/history?hours=3").json()["services"][0]["buckets"]

    assert [b["hour"] for b in buckets] == [
        "2026-09-24T10:00:00Z",
        "2026-09-24T11:00:00Z",
        "2026-09-24T12:00:00Z",
    ]


def test_history_reports_measured_hours_and_leaves_the_rest_null(api: ApiContext) -> None:
    _add_heartbeat(api, "listener", HOUR, ok=58, total=60)
    _add_heartbeat(api, "listener", HOUR - timedelta(hours=2), ok=60, total=60)
    _add_heartbeat(api, "db", HOUR - timedelta(hours=40), ok=1, total=1)  # outside the window

    body = api.client.get("/health/history?hours=24").json()

    listener = {s["service"]: s["buckets"] for s in body["services"]}["listener"]
    assert listener[-1] == {"hour": "2026-09-24T12:00:00Z", "ok": 58, "total": 60}
    assert listener[-3] == {"hour": "2026-09-24T10:00:00Z", "ok": 60, "total": 60}
    assert listener[-2]["ok"] is None and listener[-2]["total"] is None
    db = {s["service"]: s["buckets"] for s in body["services"]}["db"]
    assert all(b["total"] is None for b in db)
    # the earliest sample overall, even outside the requested window
    assert body["coverage_since"] == "2026-09-22T20:00:00Z"


def test_history_collector_hours_and_totals(api: ApiContext) -> None:
    _add_hourly(api, HOUR, "vista", 2)
    _add_hourly(api, HOUR, "sem_termo", 100)
    _add_hourly(api, HOUR, "bloqueado", 5, source="other_source")
    _add_hourly(api, HOUR, "falha_entrega", 1)
    _add_hourly(api, HOUR - timedelta(hours=1), "sem_termo", 30, source=None)
    # a quiet hour: the listener was beating but nothing was read
    _add_heartbeat(api, "listener", HOUR - timedelta(hours=2), ok=60, total=60)

    collector = api.client.get("/health/history?hours=4").json()["collector"]

    assert collector["hours"] == [
        {"hour": "2026-09-24T09:00:00Z", "seen": None, "evaluated": None},
        {"hour": "2026-09-24T10:00:00Z", "seen": 0, "evaluated": 0},
        {"hour": "2026-09-24T11:00:00Z", "seen": 0, "evaluated": 30},
        {"hour": "2026-09-24T12:00:00Z", "seen": 2, "evaluated": 107},
    ]
    assert collector["totals"] == {
        "seen": 2,
        "discarded": 135,
        "evaluated": 137,
        "delivery_failures": 1,
        "delivery_failures_last_hour": 1,
    }
    assert collector["coverage_since"] == "2026-09-24T11:00:00Z"


def test_history_validates_hours_and_requires_a_session(api: ApiContext) -> None:
    assert api.client.get("/health/history?hours=0").status_code == 422
    assert api.client.get("/health/history?hours=169").status_code == 422
    api.client.cookies.clear()
    assert api.client.get("/health/history").status_code == 401
    assert api.client.get("/health/events").status_code == 401
    assert api.client.get("/sources/activity").status_code == 401


# --- GET /health/events --------------------------------------------------------


def test_events_newest_first_with_limit(api: ApiContext) -> None:
    with api.session_factory() as session:
        for index in range(5):
            session.add(
                SystemEvent(
                    at=NOW - timedelta(minutes=index), kind="backup", summary=f"Backup {index}"
                )
            )
        session.commit()

    events = api.client.get("/health/events?limit=3").json()

    assert [event["summary"] for event in events] == ["Backup 0", "Backup 1", "Backup 2"]
    assert events[0]["at"] == "2026-09-24T12:00:00Z"
    assert events[0]["kind"] == "backup"
    assert len(api.client.get("/health/events").json()) == 5
    assert api.client.get("/health/events?limit=101").status_code == 422


# --- GET /sources/activity -------------------------------------------------------


def test_sources_activity_without_data_has_null_days_and_real_match_facts(
    api: ApiContext,
) -> None:
    _add_match(api, matched_at=NOW - timedelta(hours=5))
    _add_match(api, matched_at=NOW - timedelta(days=2), telegram_message_id=2)
    _add_match(api, matched_at=NOW - timedelta(days=30), telegram_message_id=3)

    body = api.client.get("/sources/activity?days=7").json()

    assert body["days"] == 7
    assert body["coverage_since"] is None
    by_name = {row["name"]: row for row in body["sources"]}
    group_a = by_name["Grupo A"]
    assert len(group_a["daily"]) == 7
    assert all(day["evaluated"] is None for day in group_a["daily"])
    assert group_a["matches"] == 2  # the 30-day-old one is outside the window
    assert group_a["last_match_at"] == "2026-09-24T07:00:00Z"
    assert by_name["Grupo B"]["matches"] == 0
    assert by_name["Grupo B"]["last_match_at"] is None


def test_sources_activity_buckets_days_in_the_display_timezone(api: ApiContext) -> None:
    # 02:00Z on 09-24 is 23:00 on 09-23 in America/Sao_Paulo.
    _add_hourly(api, datetime(2026, 9, 24, 2, 0, tzinfo=UTC), "vista", 3)
    _add_hourly(api, datetime(2026, 9, 24, 2, 0, tzinfo=UTC), "sem_termo", 40)
    _add_hourly(api, datetime(2026, 9, 24, 10, 0, tzinfo=UTC), "bloqueado", 7)
    _add_hourly(api, datetime(2026, 9, 24, 10, 0, tzinfo=UTC), "falha_entrega", 9)  # not traffic

    body = api.client.get("/sources/activity?days=3").json()

    assert body["coverage_since"] == "2026-09-24T02:00:00Z"
    group_a = {row["name"]: row for row in body["sources"]}["Grupo A"]
    assert [(d["day"], d["evaluated"]) for d in group_a["daily"]] == [
        ("2026-09-22", None),  # ended before the first measured hour: unknown
        ("2026-09-23", 43),  # partially measured, counts what exists
        ("2026-09-24", 7),
    ]
    group_b = {row["name"]: row for row in body["sources"]}["Grupo B"]
    assert [d["evaluated"] for d in group_b["daily"]] == [None, 0, 0]


# --- heartbeat sampler ---------------------------------------------------------------


def _samples(api: ApiContext) -> dict[str, tuple[int, int]]:
    with api.session_factory() as session:
        return {
            row.service: (row.ok, row.total) for row in session.scalars(select(ServiceHeartbeat))
        }


def test_sampler_is_disabled_in_tests_by_default() -> None:
    assert app.state.health_sampler_enabled is False


def test_sampler_skips_services_that_are_not_configured(api: ApiContext) -> None:
    HealthSampler(app, now=lambda: NOW).sample_once()

    # Telegram and the bot are off: no samples at all (not "down", not "up").
    # No listener heartbeat yet -> listener down; the feed loop and the database are up.
    assert _samples(api) == {"listener": (0, 1), "sse": (1, 1), "db": (1, 1)}


def test_sampler_marks_a_live_configured_stack_healthy(
    api: ApiContext, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setitem(app.state._state, "bot_configured", True)
    monkeypatch.setitem(
        app.state._state,
        "telegram_adapter",
        TelegramAdapter(
            api_id=1, api_hash="hash", client=FakeTelegramClient(), sleep=_no_sleep
        ),
    )
    with api.session_factory() as session:
        ensure_control_row(session)
        touch_listener_seen(session, now=NOW)

    sampler = HealthSampler(app, now=lambda: NOW)
    sampler.sample_once()
    sampler.sample_once()

    assert _samples(api) == {
        "telegram": (2, 2),
        "bot": (2, 2),
        "listener": (2, 2),
        "sse": (2, 2),
        "db": (2, 2),
    }


async def _no_sleep(_seconds: float) -> None:
    return None


def test_sampler_counts_an_unhealthy_feed_loop(
    api: ApiContext, monkeypatch: pytest.MonkeyPatch
) -> None:
    class Stalled:
        def is_healthy(self) -> bool:
            return False

    monkeypatch.setitem(app.state._state, "match_watcher", Stalled())

    HealthSampler(app, now=lambda: NOW).sample_once()

    assert _samples(api)["sse"] == (0, 1)


def test_sampler_purges_old_rows_on_first_run_then_daily(api: ApiContext) -> None:
    old = NOW - timedelta(days=31)
    _add_heartbeat(api, "db", old, 1, 1)
    sampler = HealthSampler(app, now=lambda: NOW)

    sampler.sample_once()
    with api.session_factory() as session:
        hours = [row.hour_utc for row in session.scalars(select(ServiceHeartbeat))]
    assert all(hour.replace(tzinfo=UTC) >= NOW - timedelta(days=30) for hour in hours)

    _add_heartbeat(api, "bot", old, 1, 1)
    sampler.sample_once()  # same day: no second purge
    with api.session_factory() as session:
        assert session.scalar(select(ServiceHeartbeat).where(ServiceHeartbeat.service == "bot"))


async def test_sampler_never_holds_a_transaction_while_it_sleeps(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    engine = get_engine(f"sqlite:///{tmp_path / 'sampler.db'}")
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    monkeypatch.setitem(app.state._state, "session_factory", factory)
    sleeps: list[float] = []

    async def inspecting_sleep(seconds: float) -> None:
        sleeps.append(seconds)
        # No connection is checked out of the pool, and another writer is not blocked.
        assert engine.pool.checkedout() == 0  # type: ignore[attr-defined]
        other = get_engine(f"sqlite:///{tmp_path / 'sampler.db'}")
        with other.begin() as connection:
            connection.execute(
                text("INSERT INTO system_event (at, kind, summary) VALUES (:at, 'backup', 'x')"),
                {"at": NOW},
            )
        other.dispose()
        if len(sleeps) == 2:
            raise asyncio.CancelledError

    sampler = HealthSampler(app, interval=60.0, now=lambda: NOW)
    with pytest.raises(asyncio.CancelledError):
        await sampler.run(sleep=inspecting_sleep)

    assert sleeps == [60.0, 60.0]
    with factory() as session:
        assert session.scalars(select(ServiceHeartbeat.total)).all() == [2, 2, 2]


async def test_sample_health_context_runs_and_cancels_cleanly(api: ApiContext) -> None:
    async with sample_health(app, interval=0.01):
        for _ in range(100):
            await asyncio.sleep(0.02)
            if _samples(api):
                break
    assert "db" in _samples(api)


# --- event log: where events come from --------------------------------------------------


def test_target_event_summary_uses_the_match_title_and_price() -> None:
    match = Match(
        message_text="Placa de Vídeo Nimbus RTX 5090 32GB\n💰 R$ 16.299,00 à vista",
        price_cents=1_629_900,
    )

    summary = target_event_summary(match)

    assert "alvo atingido" in summary
    assert "R$ 16.299,00" in summary
    assert "RTX 5090" in summary
    assert len(summary) <= 160


async def test_target_hit_and_delivery_failure_are_logged_without_message_text(
    session: Session,
) -> None:
    source = Source(name="Grupo Teste", telegram_chat_id="-100123")
    rule = Rule(name="RTX 5070", include_terms="rtx 5070", target_price_cents=205_000)
    ok = Recipient(name="Gabriel", telegram_chat_id="999", allowlisted=True)
    broken = Recipient(name="Sam", telegram_chat_id="888", allowlisted=True)
    session.add_all([source, rule, ok, broken])
    session.flush()
    notifier = BotNotifier(
        bot_token="token",
        client=FakeBotClient(fail_for_chat_ids={"888"}),
        allowlisted_chat_ids={"999", "888"},
    )
    secret = "SEGREDO-NAO-VAI-PRO-LOG"

    await process_message(
        session,
        IncomingMessage(
            source_id=source.id,
            message_id=1,
            text=f"RTX 5070 por R$ 2.000 na Amazon {secret}",
            link=None,
            received_at=datetime.now(UTC),
        ),
        rule,
        [ok, broken],
        notifier,
        DedupeCache(),
    )
    session.commit()

    events = {e.kind: e.summary for e in session.scalars(select(SystemEvent))}
    assert "alvo atingido" in events["match_target"]
    assert events["delivery_failure"] == "Falha ao enviar o alerta para Sam"
    assert all(secret not in summary for summary in events.values())


async def test_discarded_messages_leave_only_hourly_counts(session: Session) -> None:
    source = Source(name="Grupo Teste", telegram_chat_id="-100123")
    rule = Rule(name="RTX", include_terms="rtx 5070")
    recipient = Recipient(name="Gabriel", telegram_chat_id="999", allowlisted=True)
    session.add_all([source, rule, recipient])
    session.flush()
    notifier = BotNotifier(
        bot_token="token", client=FakeBotClient(), allowlisted_chat_ids={"999"}
    )

    await process_message(
        session,
        IncomingMessage(
            source_id=source.id,
            message_id=1,
            text="mensagem sem relação nenhuma, texto rejeitado",
            link=None,
            received_at=datetime.now(UTC),
        ),
        rule,
        [recipient],
        notifier,
        DedupeCache(),
    )
    session.commit()

    rows = session.scalars(select(MetricHourly)).all()
    assert [(row.reason, row.count) for row in rows] == [("sem_termo", 1)]
    dumped = " ".join(
        str(value)
        for table in (MetricHourly, ServiceHeartbeat, SystemEvent)
        for row in session.scalars(select(table))
        for value in vars(row).values()
    )
    assert "rejeitado" not in dumped


async def test_reconnecting_sse_client_is_logged_once_per_minute(api: ApiContext) -> None:
    broker = EventBroker()
    first = broker.publish("match", {"match_id": 1})
    broker.publish("match", {"match_id": 2})

    class FakeRequest:
        async def is_disconnected(self) -> bool:
            return False

    async def log(subscription: Any) -> None:
        from packages.metrics.hourly import EventKind, log_system_event

        log_system_event(
            api.session_factory,
            EventKind.SSE_RECONNECT,
            f"Feed reconectado — {len(subscription.backlog)} eventos reenviados",
            dedupe_within=timedelta(minutes=1),
        )

    for last_event_id in (first.id, first.id):
        gen = _stream(FakeRequest(), broker, last_event_id=last_event_id, on_reconnect=log)
        await anext(gen)
        await gen.aclose()
    gen = _stream(FakeRequest(), broker, last_event_id=None, on_reconnect=log)
    broker.publish("match", {"match_id": 3})
    await anext(gen)
    await gen.aclose()

    with api.session_factory() as session:
        summaries = session.scalars(select(SystemEvent.summary)).all()
    assert summaries == ["Feed reconectado — 1 eventos reenviados"]


def test_test_notification_is_logged_with_recipient_name_only(api: ApiContext) -> None:
    csrf = api.client.post(
        "/auth/login", json={"password": "correct horse battery staple"}
    ).json()["csrf_token"]

    response = api.client.post(
        "/notifications/test",
        json={"chat_id": "999", "text": "texto livre que nao deve ir pro log"},
        headers={"X-CSRF-Token": csrf},
    )

    assert response.status_code == 200
    events = api.client.get("/health/events").json()
    assert [(e["kind"], e["summary"]) for e in events] == [
        ("test_send", "Envio de teste para Gabriel — sent")
    ]
