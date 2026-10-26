"""S19-02: first-run setup wizard API (`/setup/*`).

Threat model: `docs/SECURITY_SETUP.md`. In short, every route needs an admin session
(and a CSRF token when it changes anything), is refused outright in demo mode, never
returns a secret (only `configured`/source flags, the bot's public username and a
masked phone hint), never echoes a rejected value back (validation errors are
scrubbed), and is rate limited so a stolen cookie is not a brute-force oracle against
the Telegram account.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.dialog_scan import clear_dialogs as clear_cached_dialogs
from app.dialog_scan import read_scan, request_scan
from app.listener_control import read_snapshot, request_reload
from app.main import get_current_session, get_db, require_csrf
from app.setup_events import recent_events, record_event
from app.setup_runtime import (
    LIMIT_BOT_TOKEN,
    LIMIT_LOGIN_ANSWER,
    LIMIT_LOGIN_START,
    PAIRING_POLL_SECONDS,
    Pairing,
    current_credentials,
    session_path,
)
from app.utc import UtcDatetime
from auth.rate_limit import EscalatingRateLimiter
from models import Recipient, Rule, Source
from packages.setup.bot_api import (
    BotApi,
    BotApiError,
    BotApiErrorCode,
    BotIdentity,
    codes_match,
    is_valid_token,
)
from packages.setup.credentials import TelegramCredentials, remove_session_files, session_present
from packages.setup.secret_store import (
    KEY_API_HASH,
    KEY_API_ID,
    KEY_BOT_TOKEN,
    KEY_BOT_USERNAME,
    SecretStore,
)
from packages.setup.telegram_login import (
    LoginError,
    LoginErrorCode,
    LoginStage,
    TelegramLoginService,
    normalize_phone,
)

BotApiFactory = Callable[[str], BotApi]

_API_HASH = re.compile(r"^[0-9a-fA-F]{32}$")
MAX_API_ID = 2**31 - 1
MAX_GROUPS_PER_CALL = 200


def require_setup_enabled() -> None:
    if get_settings().teleyes_demo:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "code": "demo_mode",
                "message": "O assistente de configuração fica desativado no modo demonstração.",
            },
        )


router = APIRouter(
    prefix="/setup",
    tags=["setup"],
    dependencies=[Depends(get_current_session), Depends(require_setup_enabled)],
)

# --- error vocabulary (pt-BR, closed set; never quotes user input) -------------------

LOGIN_MESSAGES: dict[LoginErrorCode, tuple[int, str]] = {
    LoginErrorCode.PHONE_INVALID: (
        422,
        "O número de telefone não é válido. "
        "Use o formato internacional, por exemplo +5511999998888.",
    ),
    LoginErrorCode.PHONE_BANNED: (422, "O Telegram informou que este número está banido."),
    LoginErrorCode.API_CREDENTIALS_INVALID: (
        422,
        "O Telegram recusou o api_id/api_hash. Confira os valores em my.telegram.org/apps.",
    ),
    LoginErrorCode.CODE_INVALID: (
        422,
        "Código incorreto. Confira a mensagem do Telegram e tente de novo.",
    ),
    LoginErrorCode.CODE_EXPIRED: (422, "O código expirou. Peça um novo código."),
    LoginErrorCode.PASSWORD_INVALID: (
        422,
        "Senha da verificação em duas etapas incorreta.",
    ),
    LoginErrorCode.FLOOD_WAIT: (429, "O Telegram pediu para aguardar antes de tentar de novo."),
    LoginErrorCode.NETWORK: (
        502,
        "Não foi possível falar com o Telegram. "
        "Verifique a conexão deste computador e tente de novo.",
    ),
    LoginErrorCode.NOT_STARTED: (
        409,
        "Nenhum login em andamento (ele pode ter expirado). Comece de novo.",
    ),
    LoginErrorCode.ALREADY_PENDING: (
        409,
        "Já existe um login em andamento. Conclua-o ou cancele para recomeçar.",
    ),
    LoginErrorCode.ALREADY_AUTHORIZED: (
        409,
        "Já existe uma sessão do Telegram conectada. Desconecte-a antes de entrar com outra conta.",
    ),
    LoginErrorCode.NO_API_CREDENTIALS: (409, "Informe primeiro o api_id e o api_hash."),
    LoginErrorCode.TOO_MANY_ATTEMPTS: (
        422,
        "Muitas tentativas incorretas. Peça um novo código.",
    ),
    LoginErrorCode.UNEXPECTED: (
        502,
        "Algo inesperado aconteceu no login. "
        "Tente de novo; se persistir, veja os logs do servidor.",
    ),
    LoginErrorCode.INVALID_INPUT: (422, "Valor inválido."),
}

BOT_MESSAGES: dict[BotApiErrorCode, tuple[int, str]] = {
    BotApiErrorCode.TOKEN_INVALID: (
        422,
        "O Telegram não reconheceu este token. Copie-o de novo do @BotFather.",
    ),
    BotApiErrorCode.NETWORK: (
        502,
        "Não foi possível falar com o Telegram. Verifique a conexão e tente de novo.",
    ),
    BotApiErrorCode.CONFLICT: (
        409,
        "Outro programa (ou um webhook) já está lendo as mensagens deste bot. "
        "Encerre-o e tente de novo.",
    ),
    BotApiErrorCode.UNEXPECTED: (502, "Resposta inesperada do Telegram. Tente de novo."),
}


def _fail(
    http_status: int, code: str, message: str, *, retry_after: int | None = None
) -> HTTPException:
    detail: dict[str, Any] = {"code": code, "message": message}
    headers: dict[str, str] | None = None
    if retry_after is not None:
        detail["retry_after_seconds"] = retry_after
        headers = {"Retry-After": str(retry_after)}
    return HTTPException(status_code=http_status, detail=detail, headers=headers)


def _human_wait(seconds: int) -> str:
    if seconds < 90:
        return f"{seconds} segundos"
    if seconds < 5400:
        return f"{round(seconds / 60)} minutos"
    return f"{round(seconds / 3600)} horas"


def _login_http_error(error: LoginError) -> HTTPException:
    http_status, message = LOGIN_MESSAGES[error.code]
    if error.code is LoginErrorCode.FLOOD_WAIT and error.retry_after:
        wait = _human_wait(error.retry_after)
        message = f"O Telegram pediu para aguardar {wait} antes de tentar de novo."
    return _fail(http_status, error.code.value, message, retry_after=error.retry_after)


def _bot_http_error(error: BotApiError) -> HTTPException:
    http_status, message = BOT_MESSAGES[error.code]
    return _fail(http_status, error.code.value, message)


# --- dependencies ----------------------------------------------------------------------


def get_store(request: Request) -> SecretStore:
    store: SecretStore = request.app.state.secret_store
    return store


def get_login_service(request: Request) -> TelegramLoginService:
    service: TelegramLoginService = request.app.state.telegram_login
    return service


def get_bot_api_factory(request: Request) -> BotApiFactory:
    factory: BotApiFactory = request.app.state.bot_api_factory
    return factory


def _limiter(request: Request, key: str) -> EscalatingRateLimiter:
    limiter: EscalatingRateLimiter = request.app.state.setup_limiters[key]
    return limiter


def _enforce_limit(request: Request, db: Session, key: str) -> EscalatingRateLimiter:
    limiter = _limiter(request, key)
    wait = limiter.retry_after(key)
    if wait > 0:
        record_event(db, "rate_limited", key)
        raise _fail(
            429,
            "rate_limited",
            f"Muitas tentativas. Aguarde {_human_wait(wait)} antes de tentar de novo.",
            retry_after=wait,
        )
    return limiter


def _credentials(request: Request) -> TelegramCredentials:
    return current_credentials(get_store(request), get_settings())


def _settings_session_path(request: Request) -> Path:
    return session_path(get_settings())


# --- status ------------------------------------------------------------------------------


class ApiCredentialsStatus(BaseModel):
    configured: bool
    source: Literal["env", "wizard"] | None


class LoginStatus(BaseModel):
    state: Literal["none", "awaiting_code", "awaiting_password", "authorized"]
    phone_hint: str | None = None
    expires_in_seconds: int | None = None


class BotStatus(BaseModel):
    configured: bool
    source: Literal["env", "wizard"] | None
    username: str | None
    pairing_active: bool
    pairing_expires_in_seconds: int | None


class SecurityEventResponse(BaseModel):
    kind: str
    detail: str | None
    created_at: UtcDatetime


class StepsStatus(BaseModel):
    credentials: bool
    login: bool
    bot: bool
    recipient: bool
    groups: bool
    rule: bool


NextStep = Literal["credentials", "login", "bot", "recipient", "groups", "rule", "done"]


class SetupStatus(BaseModel):
    credentials: ApiCredentialsStatus
    login: LoginStatus
    bot: BotStatus
    recipients: int
    sources: int
    rules: int
    listener_online: bool
    steps: StepsStatus
    next_step: NextStep
    # Credentials, session and bot token are all in place (the Telegram side works).
    configured: bool
    # Every step done and the listener is alive: the "tudo pronto" state.
    complete: bool
    events: list[SecurityEventResponse]


def _count(db: Session, statement: Any) -> int:
    return int(db.scalar(statement) or 0)


def build_status(request: Request, db: Session) -> SetupStatus:
    credentials = _credentials(request)
    service = get_login_service(request)
    pending = service.status()
    has_session = session_present(_settings_session_path(request))
    if pending.stage is LoginStage.AWAITING_CODE:
        login = LoginStatus(
            state="awaiting_code",
            phone_hint=pending.phone_hint,
            expires_in_seconds=pending.expires_in_seconds,
        )
    elif pending.stage is LoginStage.AWAITING_PASSWORD:
        login = LoginStatus(
            state="awaiting_password",
            phone_hint=pending.phone_hint,
            expires_in_seconds=pending.expires_in_seconds,
        )
    else:
        login = LoginStatus(state="authorized" if has_session else "none")

    recipients = _count(
        db,
        select(func.count())
        .select_from(Recipient)
        .where(Recipient.active.is_(True), Recipient.allowlisted.is_(True)),
    )
    sources = _count(db, select(func.count()).select_from(Source).where(Source.active.is_(True)))
    rules = _count(db, select(func.count()).select_from(Rule).where(Rule.active.is_(True)))

    pairing: Pairing | None = getattr(request.app.state, "bot_pairing", None)
    pairing_remaining = pairing.remaining() if pairing is not None else 0

    steps = StepsStatus(
        credentials=credentials.has_api,
        login=has_session,
        bot=credentials.has_bot,
        recipient=recipients > 0,
        groups=sources > 0,
        rule=rules > 0,
    )
    order: list[tuple[NextStep, bool]] = [
        ("credentials", steps.credentials),
        ("login", steps.login),
        ("bot", steps.bot),
        ("recipient", steps.recipient),
        ("groups", steps.groups),
        ("rule", steps.rule),
    ]
    next_step: NextStep = next((name for name, done in order if not done), "done")
    online = read_snapshot(db).listener_online
    return SetupStatus(
        credentials=ApiCredentialsStatus(
            configured=credentials.has_api, source=credentials.api_source
        ),
        login=login,
        bot=BotStatus(
            configured=credentials.has_bot,
            source=credentials.bot_source,
            username=credentials.bot_username,
            pairing_active=pairing_remaining > 0,
            pairing_expires_in_seconds=pairing_remaining or None,
        ),
        recipients=recipients,
        sources=sources,
        rules=rules,
        listener_online=online,
        steps=steps,
        next_step=next_step,
        configured=steps.credentials and steps.login and steps.bot,
        complete=next_step == "done" and online,
        events=[
            SecurityEventResponse(kind=e.kind, detail=e.detail, created_at=e.created_at)
            for e in recent_events(db)
        ],
    )


@router.get("/status", response_model=SetupStatus)
def get_status(request: Request, db: Session = Depends(get_db)) -> SetupStatus:
    return build_status(request, db)


# --- step 1: Telegram app credentials ------------------------------------------------------


class CredentialsRequest(BaseModel):
    api_id: int
    api_hash: str = Field(max_length=64)


@router.put("/credentials", response_model=SetupStatus, dependencies=[Depends(require_csrf)])
def save_credentials(
    payload: CredentialsRequest, request: Request, db: Session = Depends(get_db)
) -> SetupStatus:
    settings = get_settings()
    if get_login_service(request).status().stage is not LoginStage.IDLE:
        raise _login_http_error(LoginError(LoginErrorCode.ALREADY_PENDING))
    current = _credentials(request)
    if current.api_source == "env":
        raise _fail(
            409,
            "managed_by_env",
            "O api_id/api_hash já vêm do arquivo .env e têm prioridade. "
            "Edite o .env para trocá-los.",
        )
    api_hash = payload.api_hash.strip()
    if not 0 < payload.api_id <= MAX_API_ID or not _API_HASH.fullmatch(api_hash):
        raise _fail(
            422,
            "credentials_format",
            "O api_id é um número e o api_hash tem 32 caracteres (letras de a a f e números). "
            "Copie os dois de my.telegram.org/apps.",
        )
    if session_present(session_path(settings)) and (
        current.api_id != payload.api_id or current.api_hash != api_hash.lower()
    ):
        raise _fail(
            409,
            "already_authorized",
            "Há uma sessão conectada com outras credenciais. "
            "Desconecte o Telegram antes de trocá-las.",
        )
    if current.api_id != payload.api_id or current.api_hash != api_hash.lower():
        get_store(request).update({KEY_API_ID: payload.api_id, KEY_API_HASH: api_hash.lower()})
        record_event(db, "telegram_credentials_saved")
    return build_status(request, db)


# --- step 2: Telegram account login ------------------------------------------------------------


class PhoneRequest(BaseModel):
    phone: str = Field(max_length=40)


class CodeRequest(BaseModel):
    code: str = Field(max_length=16)


class PasswordRequest(BaseModel):
    password: str = Field(max_length=256)


@router.post(
    "/telegram/login/start", response_model=SetupStatus, dependencies=[Depends(require_csrf)]
)
async def login_start(
    payload: PhoneRequest, request: Request, db: Session = Depends(get_db)
) -> SetupStatus:
    credentials = _credentials(request)
    if not credentials.has_api or credentials.api_id is None or credentials.api_hash is None:
        raise _login_http_error(LoginError(LoginErrorCode.NO_API_CREDENTIALS))
    if session_present(session_path(get_settings())):
        raise _login_http_error(LoginError(LoginErrorCode.ALREADY_AUTHORIZED))
    service = get_login_service(request)
    try:
        normalize_phone(payload.phone)  # a typo is not an attempt against Telegram
    except LoginError as error:
        raise _login_http_error(error) from None
    if service.status().stage is not LoginStage.IDLE:
        raise _login_http_error(LoginError(LoginErrorCode.ALREADY_PENDING))
    limiter = _enforce_limit(request, db, LIMIT_LOGIN_START)
    limiter.record_failure(LIMIT_LOGIN_START)  # every start sends a code: count the attempt
    try:
        await service.start(
            phone=payload.phone, api_id=credentials.api_id, api_hash=credentials.api_hash
        )
    except LoginError as error:
        record_event(db, "telegram_login_failed", error.code.value)
        raise _login_http_error(error) from None
    record_event(db, "telegram_login_started")
    return build_status(request, db)


@router.post(
    "/telegram/login/code", response_model=SetupStatus, dependencies=[Depends(require_csrf)]
)
async def login_code(
    payload: CodeRequest, request: Request, db: Session = Depends(get_db)
) -> SetupStatus:
    limiter = _enforce_limit(request, db, LIMIT_LOGIN_ANSWER)
    service = get_login_service(request)
    try:
        await service.submit_code(payload.code)
    except LoginError as error:
        if error.code in (LoginErrorCode.CODE_INVALID, LoginErrorCode.TOO_MANY_ATTEMPTS):
            limiter.record_failure(LIMIT_LOGIN_ANSWER)
        record_event(db, "telegram_login_failed", error.code.value)
        raise _login_http_error(error) from None
    return _after_login_step(request, db, limiter)


@router.post(
    "/telegram/login/password", response_model=SetupStatus, dependencies=[Depends(require_csrf)]
)
async def login_password(
    payload: PasswordRequest, request: Request, db: Session = Depends(get_db)
) -> SetupStatus:
    limiter = _enforce_limit(request, db, LIMIT_LOGIN_ANSWER)
    service = get_login_service(request)
    try:
        await service.submit_password(payload.password)
    except LoginError as error:
        if error.code in (LoginErrorCode.PASSWORD_INVALID, LoginErrorCode.TOO_MANY_ATTEMPTS):
            limiter.record_failure(LIMIT_LOGIN_ANSWER)
        record_event(db, "telegram_login_failed", error.code.value)
        raise _login_http_error(error) from None
    return _after_login_step(request, db, limiter)


def _after_login_step(request: Request, db: Session, limiter: EscalatingRateLimiter) -> SetupStatus:
    """A correct code may lead to the 2FA prompt; only a finished login is a success."""
    if get_login_service(request).status().stage is LoginStage.IDLE:
        limiter.record_success(LIMIT_LOGIN_ANSWER)
        get_store(request).bump_generation()
        record_event(db, "telegram_login_succeeded")
    return build_status(request, db)


@router.post(
    "/telegram/login/cancel", response_model=SetupStatus, dependencies=[Depends(require_csrf)]
)
async def login_cancel(request: Request, db: Session = Depends(get_db)) -> SetupStatus:
    service = get_login_service(request)
    if service.status().stage is not LoginStage.IDLE:
        await service.cancel()
        record_event(db, "telegram_login_cancelled")
    return build_status(request, db)


class DisconnectRequest(BaseModel):
    confirm: bool = False


@router.post(
    "/telegram/disconnect", response_model=SetupStatus, dependencies=[Depends(require_csrf)]
)
async def disconnect_telegram(
    payload: DisconnectRequest, request: Request, db: Session = Depends(get_db)
) -> SetupStatus:
    """Delete the session file and every secret the wizard stored.

    The listener notices the change within seconds and drops its connection. Values
    that come from `.env` are not touched (the file is the user's); the account's
    session should also be ended in Telegram (Settings, Devices), which only the
    account owner can do.
    """
    if not payload.confirm:
        raise _fail(422, "confirmation_required", "Confirme para desconectar o Telegram.")
    await get_login_service(request).cancel()
    remove_session_files(session_path(get_settings()))
    store = get_store(request)
    store.clear_secrets()
    store.bump_generation()
    request.app.state.bot_pairing = None
    clear_cached_dialogs(db)
    record_event(db, "session_removed")
    return build_status(request, db)


# --- step 3: alert bot ------------------------------------------------------------------------


class BotTokenRequest(BaseModel):
    token: str = Field(max_length=128)


@router.put("/bot", response_model=SetupStatus, dependencies=[Depends(require_csrf)])
async def save_bot_token(
    payload: BotTokenRequest,
    request: Request,
    db: Session = Depends(get_db),
    bot_api_factory: BotApiFactory = Depends(get_bot_api_factory),
) -> SetupStatus:
    if _credentials(request).bot_source == "env":
        raise _fail(
            409,
            "managed_by_env",
            "O token do bot já vem do arquivo .env e tem prioridade. Edite o .env para trocá-lo.",
        )
    limiter = _enforce_limit(request, db, LIMIT_BOT_TOKEN)
    token = payload.token.strip()
    if not is_valid_token(token):
        limiter.record_failure(LIMIT_BOT_TOKEN)
        raise _fail(
            422,
            "token_format",
            "O token tem o formato 123456789:ABC... Copie-o inteiro da conversa com o @BotFather.",
        )
    try:
        identity = await bot_api_factory(token).get_me()
    except BotApiError as error:
        if error.code is BotApiErrorCode.TOKEN_INVALID:
            limiter.record_failure(LIMIT_BOT_TOKEN)
        raise _bot_http_error(error) from None
    limiter.record_success(LIMIT_BOT_TOKEN)
    get_store(request).update({KEY_BOT_TOKEN: token, KEY_BOT_USERNAME: identity.username})
    get_store(request).bump_generation()
    request.app.state.bot_pairing = None
    record_event(db, "bot_configured")
    return build_status(request, db)


class PairingResponse(BaseModel):
    code: str
    deep_link: str
    bot_username: str
    expires_in_seconds: int


async def _bot_identity(
    request: Request, bot_api_factory: BotApiFactory
) -> tuple[TelegramCredentials, BotIdentity]:
    credentials = _credentials(request)
    if not credentials.bot_token:
        raise _fail(409, "bot_not_configured", "Configure primeiro o token do bot.")
    try:
        identity = await bot_api_factory(credentials.bot_token).get_me()
    except BotApiError as error:
        raise _bot_http_error(error) from None
    return credentials, identity


@router.post("/bot/pairing", response_model=PairingResponse, dependencies=[Depends(require_csrf)])
async def start_pairing(
    request: Request,
    bot_api_factory: BotApiFactory = Depends(get_bot_api_factory),
) -> PairingResponse:
    """Open a window in which `/start <code>` adds a recipient."""
    _, identity = await _bot_identity(request, bot_api_factory)
    pairing = Pairing.new()
    request.app.state.bot_pairing = pairing
    return PairingResponse(
        code=pairing.code,
        deep_link=f"https://t.me/{identity.username}?start={pairing.code}",
        bot_username=identity.username,
        expires_in_seconds=pairing.remaining(),
    )


class PairedRecipient(BaseModel):
    id: int
    name: str


class PairingPollResponse(BaseModel):
    state: Literal["waiting", "paired", "expired"]
    recipient: PairedRecipient | None = None
    # `/start` messages that arrived without the code (ignored, never registered).
    ignored_starts: int = 0


@router.post(
    "/bot/pairing/poll", response_model=PairingPollResponse, dependencies=[Depends(require_csrf)]
)
async def poll_pairing(
    request: Request,
    db: Session = Depends(get_db),
    bot_api_factory: BotApiFactory = Depends(get_bot_api_factory),
) -> PairingPollResponse:
    pairing: Pairing | None = getattr(request.app.state, "bot_pairing", None)
    if pairing is None or pairing.remaining() <= 0:
        request.app.state.bot_pairing = None
        return PairingPollResponse(state="expired")
    token = _credentials(request).bot_token
    if not token:
        raise _fail(409, "bot_not_configured", "Configure primeiro o token do bot.")
    if pairing.lock.locked():  # another tab is already long-polling this bot
        return PairingPollResponse(state="waiting")
    async with pairing.lock:
        try:
            updates = await bot_api_factory(token).get_start_messages(
                pairing.offset, PAIRING_POLL_SECONDS
            )
        except BotApiError as error:
            raise _bot_http_error(error) from None
        if updates.next_offset is not None:
            pairing.offset = updates.next_offset
    ignored = 0
    for start in updates.starts:
        if not codes_match(pairing.code, start.payload):
            ignored += 1
            continue
        recipient = _register_recipient(db, start.chat_id, start.sender_name)
        request.app.state.bot_pairing = None
        record_event(db, "bot_paired")
        return PairingPollResponse(
            state="paired",
            recipient=PairedRecipient(id=recipient.id, name=recipient.name),
            ignored_starts=ignored,
        )
    return PairingPollResponse(state="waiting", ignored_starts=ignored)


def _register_recipient(db: Session, chat_id: str, sender_name: str) -> Recipient:
    existing = db.scalar(select(Recipient).where(Recipient.telegram_chat_id == chat_id))
    if existing is not None:
        existing.active = True
        existing.allowlisted = True
        db.commit()
        return existing
    recipient = Recipient(
        name=sender_name.strip() or "Destinatário", telegram_chat_id=chat_id, allowlisted=True
    )
    db.add(recipient)
    db.commit()
    return recipient


# --- step 4: choose the groups ------------------------------------------------------------------


class DialogResponse(BaseModel):
    chat_id: str
    title: str
    kind: Literal["group", "channel"]
    monitored: bool


class GroupsResponse(BaseModel):
    # waiting_listener: the monitor process is not running yet (or not connected).
    state: Literal["idle", "waiting_listener", "pending", "running", "done", "failed"]
    error: str | None
    dialogs: list[DialogResponse]


@router.get("/groups", response_model=GroupsResponse)
def get_groups(db: Session = Depends(get_db)) -> GroupsResponse:
    snapshot = read_scan(db)
    monitored = set(db.scalars(select(Source.telegram_chat_id).where(Source.active.is_(True))))
    state: str = snapshot.state
    if state in ("pending", "running") and not read_snapshot(db).listener_online:
        state = "waiting_listener"
    return GroupsResponse(
        state=state,  # type: ignore[arg-type]
        error=snapshot.error,
        dialogs=[
            DialogResponse(
                chat_id=d.chat_id,
                title=d.title,
                kind=d.kind,  # type: ignore[arg-type]
                monitored=d.chat_id in monitored,
            )
            for d in snapshot.dialogs
        ],
    )


@router.post("/groups/refresh", response_model=GroupsResponse, dependencies=[Depends(require_csrf)])
def refresh_groups(db: Session = Depends(get_db)) -> GroupsResponse:
    request_scan(db)
    return get_groups(db)


class SelectGroupsRequest(BaseModel):
    chat_ids: list[str] = Field(max_length=MAX_GROUPS_PER_CALL)


class SelectGroupsResponse(BaseModel):
    created: int
    already_monitored: int


@router.post(
    "/groups/select", response_model=SelectGroupsResponse, dependencies=[Depends(require_csrf)]
)
def select_groups(
    payload: SelectGroupsRequest, db: Session = Depends(get_db)
) -> SelectGroupsResponse:
    """Register the chosen groups as sources. Only ids the listener actually saw."""
    snapshot = read_scan(db)
    known = {d.chat_id: d for d in snapshot.dialogs}
    wanted = list(dict.fromkeys(payload.chat_ids))
    if not wanted or any(chat_id not in known for chat_id in wanted):
        raise _fail(
            422,
            "unknown_group",
            "Escolha grupos da lista. Atualize a lista se um grupo novo não aparece.",
        )
    created = 0
    already = 0
    for chat_id in wanted:
        source = db.scalar(select(Source).where(Source.telegram_chat_id == chat_id))
        if source is None:
            db.add(Source(name=known[chat_id].title, telegram_chat_id=chat_id))
            created += 1
        elif not source.active:
            source.active = True
            created += 1
        else:
            already += 1
    db.commit()
    request_reload(db)
    return SelectGroupsResponse(created=created, already_monitored=already)
