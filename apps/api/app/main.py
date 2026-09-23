import asyncio
import itertools
import time
from collections.abc import Iterator

from fastapi import Cookie, Depends, FastAPI, HTTPException, Request, Response
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from auth.csrf import verify_csrf_token
from auth.hashing import verify_password
from auth.rate_limit import LoginRateLimiter
from auth.session import SessionRecord, SessionStore
from models import Admin
from models.db import get_engine, get_sessionmaker
from packages.events.broker import EventBroker
from packages.notifications.bot import BotNotifier
from packages.notifications.http_client import HttpBotClient
from packages.rules.dedupe import DedupeCache
from packages.telegram.adapter import AdapterState, TelegramAdapter

SESSION_COOKIE_NAME = "teleyes_session"

app = FastAPI(title="teleyes", version="0.1.0")
app.state.session_store = SessionStore()
app.state.rate_limiter = LoginRateLimiter()
app.state.session_factory = get_sessionmaker(get_engine())
app.state.started_at = time.monotonic()
app.state.event_broker = EventBroker()


def _publish_adapter_state_event(state: AdapterState) -> None:
    app.state.event_broker.publish("adapter_state", {"state": state.value})


_runtime_settings = get_settings()
app.state.telegram_adapter = TelegramAdapter(
    api_id=_runtime_settings.tg_api_id,
    api_hash=_runtime_settings.tg_api_hash,
    client=None,
    sleep=asyncio.sleep,
    on_state_change=_publish_adapter_state_event,
)
app.state.bot_configured = bool(_runtime_settings.bot_token)
app.state.notification_test_ids = itertools.count(start=-1, step=-1)
app.state.demo_dedupe_cache = DedupeCache()


def _build_bot_notifier(allowlisted_chat_ids: set[str]) -> BotNotifier:
    bot_token = get_settings().bot_token
    client = HttpBotClient(bot_token) if bot_token else None
    return BotNotifier(
        bot_token=bot_token,
        client=client,
        allowlisted_chat_ids=allowlisted_chat_ids,
    )


app.state.bot_notifier_factory = _build_bot_notifier


def get_db(request: Request) -> Iterator[Session]:
    with request.app.state.session_factory() as session:
        try:
            yield session
        except Exception:
            session.rollback()
            raise


def get_current_session(
    request: Request,
    session_id: str | None = Cookie(default=None, alias=SESSION_COOKIE_NAME),
) -> SessionRecord:
    if session_id is None:
        raise HTTPException(status_code=401, detail="not authenticated")
    store: SessionStore = request.app.state.session_store
    record = store.get_session(session_id)
    if record is None:
        raise HTTPException(status_code=401, detail="not authenticated")
    return record


def require_csrf(
    request: Request, session: SessionRecord = Depends(get_current_session)
) -> SessionRecord:
    token = request.headers.get("x-csrf-token")
    if not verify_csrf_token(session, token):
        raise HTTPException(status_code=403, detail="invalid csrf token")
    return session


class LoginRequest(BaseModel):
    password: str


@app.post("/auth/login")
def login(
    payload: LoginRequest,
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
) -> dict[str, str]:
    rate_limiter: LoginRateLimiter = request.app.state.rate_limiter
    client_key = request.client.host if request.client else "unknown"

    if rate_limiter.is_locked(client_key):
        raise HTTPException(status_code=429, detail="too many attempts, try again later")

    admin = db.scalar(select(Admin))
    if admin is None or not verify_password(payload.password, admin.password_hash):
        rate_limiter.record_failure(client_key)
        raise HTTPException(status_code=401, detail="invalid credentials")

    rate_limiter.record_success(client_key)
    store: SessionStore = request.app.state.session_store
    record = store.create_session(admin.id)
    response.set_cookie(
        SESSION_COOKIE_NAME,
        record.session_id,
        httponly=True,
        secure=True,
        samesite="strict",
    )
    return {"csrf_token": record.csrf_token}


@app.get("/auth/me")
def me(session: SessionRecord = Depends(get_current_session)) -> dict[str, int]:
    return {"admin_id": session.admin_id}


@app.post("/auth/logout")
def logout(response: Response, session: SessionRecord = Depends(require_csrf)) -> dict[str, str]:
    app.state.session_store.delete_session(session.session_id)
    response.delete_cookie(SESSION_COOKIE_NAME)
    return {"status": "logged_out"}


def _register_routers() -> None:
    from app.routers.demo import router as demo_router
    from app.routers.events import router as events_router
    from app.routers.health import router as health_router
    from app.routers.listener import router as listener_router
    from app.routers.matches import router as matches_router
    from app.routers.metrics import router as metrics_router
    from app.routers.notifications import router as notifications_router
    from app.routers.products import router as products_router
    from app.routers.recipients import router as recipients_router
    from app.routers.rules import router as rules_router
    from app.routers.sources import router as sources_router

    app.include_router(health_router)
    app.include_router(rules_router)
    app.include_router(sources_router)
    app.include_router(recipients_router)
    app.include_router(matches_router)
    app.include_router(products_router)
    app.include_router(metrics_router)
    app.include_router(notifications_router)
    app.include_router(events_router)
    app.include_router(listener_router)
    app.include_router(demo_router)


_register_routers()
