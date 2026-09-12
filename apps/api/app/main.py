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

SESSION_COOKIE_NAME = "teleyes_session"

app = FastAPI(title="teleyes")
app.state.session_store = SessionStore()
app.state.rate_limiter = LoginRateLimiter()
app.state.session_factory = get_sessionmaker(get_engine())


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


@app.get("/health")
def health() -> dict[str, str]:
    settings = get_settings()
    return {"status": "ok", "env": settings.app_env}


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


def _register_configuration_routers() -> None:
    from app.routers.recipients import router as recipients_router
    from app.routers.rules import router as rules_router
    from app.routers.sources import router as sources_router

    app.include_router(rules_router)
    app.include_router(sources_router)
    app.include_router(recipients_router)


_register_configuration_routers()
