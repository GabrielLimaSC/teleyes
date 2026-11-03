import time
from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, FastAPI, Query, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.activity import read_events, read_history
from app.config import get_settings
from app.main import get_current_session, get_db
from app.setup_runtime import current_credentials
from app.utc import UtcDatetime, utc_now
from packages.telegram.adapter import AdapterState, TelegramAdapter

router = APIRouter(tags=["health"])


class TelegramHealth(BaseModel):
    configured: bool
    state: AdapterState


class BotHealth(BaseModel):
    configured: bool
    state: Literal["configured", "not_configured", "demo"]


class HealthResponse(BaseModel):
    status: Literal["ok"]
    env: str
    version: str
    uptime_seconds: float
    telegram: TelegramHealth
    bot: BotHealth
    # S19-03: true only when started with TELEYES_DEMO=1; the panel shows a banner.
    demo: bool = False


def _bot_state(configured: bool, demo: bool) -> Literal["configured", "not_configured", "demo"]:
    if demo:
        return "demo"
    return "configured" if configured else "not_configured"


def telegram_health(app: FastAPI) -> TelegramHealth:
    settings = get_settings()
    adapter: TelegramAdapter = app.state.telegram_adapter
    # S19-02: credentials saved by the setup wizard count as configured too.
    credentials = current_credentials(app.state.secret_store, settings)
    return TelegramHealth(
        configured=adapter.is_configured() or credentials.has_api,
        state=AdapterState.DEMO if settings.teleyes_demo else adapter.state,
    )


def bot_health(app: FastAPI) -> BotHealth:
    settings = get_settings()
    credentials = current_credentials(app.state.secret_store, settings)
    bot_configured: bool = app.state.bot_configured or credentials.has_bot
    return BotHealth(
        configured=bot_configured,
        state=_bot_state(bot_configured, settings.teleyes_demo),
    )


@router.get("/health", response_model=HealthResponse)
def health(request: Request) -> HealthResponse:
    settings = get_settings()
    started_at: float = request.app.state.started_at

    return HealthResponse(
        status="ok",
        env=settings.app_env,
        version=request.app.version,
        uptime_seconds=round(max(0.0, time.monotonic() - started_at), 3),
        telegram=telegram_health(request.app),
        bot=bot_health(request.app),
        demo=settings.teleyes_demo,
    )


class HeartbeatBucketResponse(BaseModel):
    """One hour of one service. `ok` of `total` samples were healthy; both `null` means
    nothing was measured that hour ("coletando"), which is not the same as down or up."""

    hour: UtcDatetime
    ok: int | None
    total: int | None


class CollectorHourResponse(BaseModel):
    """`seen`: positive rule evaluations (the `vista` counter, i.e. matches).
    `evaluated`: seen plus every discarded evaluation. Both `null` when unmeasured."""

    hour: UtcDatetime
    seen: int | None
    evaluated: int | None


class CollectorTotalsResponse(BaseModel):
    seen: int
    discarded: int
    evaluated: int
    delivery_failures: int
    delivery_failures_last_hour: int


class CollectorHistoryResponse(BaseModel):
    coverage_since: UtcDatetime | None
    hours: list[CollectorHourResponse]
    totals: CollectorTotalsResponse


class ServiceHistoryResponse(BaseModel):
    service: Literal["telegram", "bot", "listener", "sse", "db"]
    buckets: list[HeartbeatBucketResponse]


class HealthHistoryResponse(BaseModel):
    hours: int
    # First hour with any heartbeat sample: earlier buckets are "coletando", not healthy.
    coverage_since: UtcDatetime | None
    services: list[ServiceHistoryResponse]
    collector: CollectorHistoryResponse


class SystemEventResponse(BaseModel):
    id: int
    at: UtcDatetime
    kind: Literal[
        "match_target",
        "sse_reconnect",
        "rules_applied",
        "backup",
        "test_send",
        "listener_reconnect",
        "delivery_failure",
    ]
    summary: str


@router.get(
    "/health/history",
    response_model=HealthHistoryResponse,
    dependencies=[Depends(get_current_session)],
)
def health_history(
    hours: Annotated[int, Query(ge=1, le=168)] = 24,
    db: Session = Depends(get_db),
    now: datetime = Depends(utc_now),
) -> HealthHistoryResponse:
    snapshot = read_history(db, now, hours)
    return HealthHistoryResponse(
        hours=snapshot.hours,
        coverage_since=snapshot.coverage_since,
        services=[
            ServiceHistoryResponse(
                service=service.value,
                buckets=[HeartbeatBucketResponse(**vars(bucket)) for bucket in buckets],
            )
            for service, buckets in snapshot.services.items()
        ],
        collector=CollectorHistoryResponse(
            coverage_since=snapshot.collector_coverage_since,
            hours=[CollectorHourResponse(**vars(hour)) for hour in snapshot.collector_hours],
            totals=CollectorTotalsResponse(**vars(snapshot.collector_totals)),
        ),
    )


@router.get(
    "/health/events",
    response_model=list[SystemEventResponse],
    dependencies=[Depends(get_current_session)],
)
def health_events(
    limit: Annotated[int, Query(ge=1, le=100)] = 20, db: Session = Depends(get_db)
) -> list[SystemEventResponse]:
    return [
        SystemEventResponse(id=event.id, at=event.at, kind=event.kind, summary=event.summary)  # type: ignore[arg-type]
        for event in read_events(db, limit)
    ]
