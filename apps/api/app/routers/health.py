import time
from typing import Literal

from fastapi import APIRouter, Request
from pydantic import BaseModel

from app.config import get_settings
from packages.telegram.adapter import AdapterState, TelegramAdapter

router = APIRouter(tags=["health"])


class TelegramHealth(BaseModel):
    configured: bool
    state: AdapterState


class BotHealth(BaseModel):
    configured: bool
    state: Literal["configured", "not_configured"]


class HealthResponse(BaseModel):
    status: Literal["ok"]
    env: str
    version: str
    uptime_seconds: float
    telegram: TelegramHealth
    bot: BotHealth


@router.get("/health", response_model=HealthResponse)
def health(request: Request) -> HealthResponse:
    settings = get_settings()
    adapter: TelegramAdapter = request.app.state.telegram_adapter
    bot_configured: bool = request.app.state.bot_configured
    started_at: float = request.app.state.started_at

    return HealthResponse(
        status="ok",
        env=settings.app_env,
        version=request.app.version,
        uptime_seconds=round(max(0.0, time.monotonic() - started_at), 3),
        telegram=TelegramHealth(
            configured=adapter.is_configured(),
            state=adapter.state,
        ),
        bot=BotHealth(
            configured=bot_configured,
            state="configured" if bot_configured else AdapterState.NOT_CONFIGURED.value,
        ),
    )
