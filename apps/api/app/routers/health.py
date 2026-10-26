import time
from typing import Literal

from fastapi import APIRouter, Request
from pydantic import BaseModel

from app.config import get_settings
from app.setup_runtime import current_credentials
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


@router.get("/health", response_model=HealthResponse)
def health(request: Request) -> HealthResponse:
    settings = get_settings()
    adapter: TelegramAdapter = request.app.state.telegram_adapter
    # S19-02: credentials saved by the setup wizard count as configured too.
    credentials = current_credentials(request.app.state.secret_store, settings)
    bot_configured: bool = request.app.state.bot_configured or credentials.has_bot
    started_at: float = request.app.state.started_at

    return HealthResponse(
        status="ok",
        env=settings.app_env,
        version=request.app.version,
        uptime_seconds=round(max(0.0, time.monotonic() - started_at), 3),
        telegram=TelegramHealth(
            configured=adapter.is_configured() or credentials.has_api,
            state=AdapterState.DEMO if settings.teleyes_demo else adapter.state,
        ),
        bot=BotHealth(
            configured=bot_configured,
            state=_bot_state(bot_configured, settings.teleyes_demo),
        ),
        demo=settings.teleyes_demo,
    )
