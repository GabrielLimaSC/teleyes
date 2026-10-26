import asyncio
import contextlib
import itertools
import time
from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager

from fastapi import Cookie, Depends, FastAPI, HTTPException, Request, Response
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.demo_mode import DemoNotifier, DemoReadOnlyMiddleware, check_database_mode
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


@asynccontextmanager
async def _lifespan(application: FastAPI) -> AsyncIterator[None]:
    # S17-03: the listener runs in another process, so the api watches the
    # shared SQLite file and publishes new matches to its in-memory broker.
    from app.demo_runtime import demo_background
    from app.match_watcher import watch_matches

    settings = get_settings()
    # S19-03: the demo password may only ever sit next to fictional data, and
    # a demo database must never be served as a real one (and vice versa).
    with application.state.session_factory() as session:
        check_database_mode(session, demo=settings.teleyes_demo)

    async with contextlib.AsyncExitStack() as stack:
        if settings.teleyes_demo:
            await stack.enter_async_context(
                demo_background(application.state.session_factory, live=settings.teleyes_demo_live)
            )
        await stack.enter_async_context(
            watch_matches(application.state.session_factory, application.state.event_broker)
        )
        yield


app = FastAPI(title="teleyes", version="0.1.0", lifespan=_lifespan)
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
    if get_settings().teleyes_demo:
        # S19-03: no bot in the demo; this notifier cannot open a connection.
        return DemoNotifier()
    bot_token = get_settings().bot_token
    client = HttpBotClient(bot_token) if bot_token else None
    return BotNotifier(
        bot_token=bot_token,
        client=client,
        allowlisted_chat_ids=allowlisted_chat_ids,
    )


app.state.bot_notifier_factory = _build_bot_notifier


def _demo_readonly_active() -> bool:
    settings = get_settings()
    return settings.teleyes_demo and settings.teleyes_demo_readonly


app.add_middleware(DemoReadOnlyMiddleware, is_active=_demo_readonly_active)


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


def _session_cookie_secure() -> bool:
    settings = get_settings()
    return settings.session_cookie_secure and not settings.teleyes_demo


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
        # S19-03: the public demo is reached over plain http://localhost by
        # strangers, and Safari drops Secure cookies there. Real deployments
        # (demo off) keep Secure.
        # S19-01: a plain-http self-host sets SESSION_COOKIE_SECURE=false for the
        # same reason; the default stays Secure.
        secure=_session_cookie_secure(),
        samesite="strict",
    )
    return {"csrf_token": record.csrf_token}


class MeResponse(BaseModel):
    admin_id: int
    csrf_token: str


@app.get("/auth/me")
def me(session: SessionRecord = Depends(get_current_session)) -> MeResponse:
    # S20-01: hands the CSRF token back so a reload or new tab recovers it. Safe:
    # the request is authenticated by the HttpOnly SameSite=strict cookie and
    # this app sets no CORS headers, so no other origin can read the response.
    return MeResponse(admin_id=session.admin_id, csrf_token=session.csrf_token)


@app.post("/auth/logout")
def logout(response: Response, session: SessionRecord = Depends(require_csrf)) -> dict[str, str]:
    app.state.session_store.delete_session(session.session_id)
    response.delete_cookie(SESSION_COOKIE_NAME)
    return {"status": "logged_out"}


def _register_routers() -> None:
    from app.routers.demo import router as demo_router
    from app.routers.digest import router as digest_router
    from app.routers.events import router as events_router
    from app.routers.health import router as health_router
    from app.routers.listener import router as listener_router
    from app.routers.matches import router as matches_router
    from app.routers.metrics import router as metrics_router
    from app.routers.notifications import router as notifications_router
    from app.routers.products import router as products_router
    from app.routers.purchases import router as purchases_router
    from app.routers.recipients import router as recipients_router
    from app.routers.rules import router as rules_router
    from app.routers.savings_report import router as savings_report_router
    from app.routers.settings import router as settings_router
    from app.routers.snoozes import router as snoozes_router
    from app.routers.sources import router as sources_router

    app.include_router(health_router)
    app.include_router(rules_router)
    app.include_router(sources_router)
    app.include_router(recipients_router)
    app.include_router(matches_router)
    app.include_router(products_router)
    app.include_router(snoozes_router)
    app.include_router(purchases_router)
    app.include_router(savings_report_router)
    app.include_router(metrics_router)
    app.include_router(notifications_router)
    app.include_router(events_router)
    app.include_router(listener_router)
    app.include_router(demo_router)
    app.include_router(settings_router)
    app.include_router(digest_router)


_register_routers()
