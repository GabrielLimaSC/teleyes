"""S19-02: the Telegram account login, driven from the dashboard.

`TelegramLoginService` walks `send_code_request` -> `sign_in(code)` ->
`sign_in(password)` (only when the account has 2FA) on a Telethon client living in the
api process. Guarantees:

* one pending login at a time, held only in memory, never persisted;
* a short TTL: an abandoned login is closed by a timer, not left half open;
* the client is always disconnected when the login ends, fails, expires or is cancelled;
* the session is written to a *pending* file and moved over the real one atomically
  only after a successful sign-in, so a failed or abandoned login never leaves a
  half-baked `.session` that the listener could mistake for a good one;
* no phone number, code, password, hash or session content is ever logged or placed in
  an exception message: errors are reduced to a closed set of codes.

The Telethon client is built by an injected factory, so tests (and the e2e suite) run
the whole flow against a fake and never touch the network.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import re
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from typing import Any, Protocol

from telethon import errors

from packages.setup.credentials import session_files

logger = logging.getLogger(__name__)

LOGIN_TTL_SECONDS = 300.0
MAX_CODE_ATTEMPTS = 5
SESSION_MODE = 0o600

_PHONE = re.compile(r"^\+[1-9]\d{6,14}$")
_CODE = re.compile(r"^\d{4,8}$")
MAX_PASSWORD_LENGTH = 256


class LoginErrorCode(StrEnum):
    PHONE_INVALID = "phone_invalid"
    PHONE_BANNED = "phone_banned"
    API_CREDENTIALS_INVALID = "api_credentials_invalid"
    CODE_INVALID = "code_invalid"
    CODE_EXPIRED = "code_expired"
    PASSWORD_INVALID = "password_invalid"
    FLOOD_WAIT = "flood_wait"
    NETWORK = "network"
    NOT_STARTED = "not_started"
    ALREADY_PENDING = "already_pending"
    ALREADY_AUTHORIZED = "already_authorized"
    NO_API_CREDENTIALS = "no_api_credentials"
    TOO_MANY_ATTEMPTS = "too_many_attempts"
    UNEXPECTED = "unexpected"
    INVALID_INPUT = "invalid_input"


class LoginError(Exception):
    """A login failure reduced to a code (and a wait, for flood control)."""

    def __init__(self, code: LoginErrorCode, *, retry_after: int | None = None) -> None:
        super().__init__(code.value)
        self.code = code
        self.retry_after = retry_after


class LoginStage(StrEnum):
    IDLE = "idle"
    AWAITING_CODE = "awaiting_code"
    AWAITING_PASSWORD = "awaiting_password"


@dataclass(frozen=True)
class LoginStatus:
    stage: LoginStage
    phone_hint: str | None = None
    expires_in_seconds: int | None = None


class TelegramLoginClient(Protocol):
    async def connect(self) -> None: ...

    async def disconnect(self) -> Any: ...

    async def send_code_request(self, phone: str) -> Any: ...

    async def sign_in(
        self,
        phone: str | None = None,
        code: str | None = None,
        *,
        password: str | None = None,
        phone_code_hash: str | None = None,
    ) -> Any: ...


ClientFactory = Callable[[Path, int, str], TelegramLoginClient]
Clock = Callable[[], float]
AuthorizedHook = Callable[[], Awaitable[None] | None]


def telethon_client_factory(session_path: Path, api_id: int, api_hash: str) -> TelegramLoginClient:
    """The real factory. Imported lazily so importing this module never needs the network."""
    from telethon import TelegramClient

    return TelegramClient(
        str(session_path), api_id, api_hash, connection_retries=2, request_retries=2, timeout=15
    )


def normalize_phone(raw: str) -> str:
    """E.164 with a leading `+`; spaces, dashes, dots and parentheses are tolerated."""
    cleaned = re.sub(r"[\s().\-]", "", raw or "")
    if not _PHONE.fullmatch(cleaned):
        raise LoginError(LoginErrorCode.PHONE_INVALID)
    return cleaned


def mask_phone(phone: str) -> str:
    return f"{phone[:3]}{'•' * max(0, len(phone) - 7)}{phone[-4:]}"


def pending_session_path(session_path: Path) -> Path:
    stem = session_path.name.removesuffix(".session")
    return session_path.with_name(f"{stem}.pending.session")


def _map_error(error: BaseException) -> LoginError:
    """Closed mapping from a Telethon/OS error to a code; the message is dropped."""
    if isinstance(error, LoginError):
        return error
    if isinstance(error, errors.FloodWaitError):
        return LoginError(LoginErrorCode.FLOOD_WAIT, retry_after=int(getattr(error, "seconds", 60)))
    if isinstance(error, errors.PhoneNumberFloodError):
        return LoginError(LoginErrorCode.FLOOD_WAIT, retry_after=3600)
    if isinstance(error, errors.PhoneNumberInvalidError):
        return LoginError(LoginErrorCode.PHONE_INVALID)
    if isinstance(error, errors.PhoneNumberBannedError):
        return LoginError(LoginErrorCode.PHONE_BANNED)
    if isinstance(error, errors.ApiIdInvalidError):
        return LoginError(LoginErrorCode.API_CREDENTIALS_INVALID)
    if isinstance(error, errors.PhoneCodeExpiredError):
        return LoginError(LoginErrorCode.CODE_EXPIRED)
    if isinstance(error, (errors.PhoneCodeInvalidError, errors.PhoneCodeEmptyError)):
        return LoginError(LoginErrorCode.CODE_INVALID)
    if isinstance(error, errors.PasswordHashInvalidError):
        return LoginError(LoginErrorCode.PASSWORD_INVALID)
    if isinstance(error, (ConnectionError, OSError, TimeoutError, asyncio.TimeoutError)):
        return LoginError(LoginErrorCode.NETWORK)
    return LoginError(LoginErrorCode.UNEXPECTED)


@dataclass
class _Pending:
    client: TelegramLoginClient
    phone: str
    phone_code_hash: str
    stage: LoginStage
    expires_at: float
    bad_codes: int = 0


class TelegramLoginService:
    def __init__(
        self,
        *,
        session_path: Path,
        client_factory: ClientFactory = telethon_client_factory,
        clock: Clock = time.monotonic,
        ttl_seconds: float = LOGIN_TTL_SECONDS,
    ) -> None:
        self._session_path = session_path
        self._factory = client_factory
        self._clock = clock
        self._ttl = ttl_seconds
        self._pending: _Pending | None = None
        self._lock = asyncio.Lock()
        self._expiry: asyncio.Task[None] | None = None

    # -- public API ------------------------------------------------------------------

    def status(self) -> LoginStatus:
        pending = self._live_pending()
        if pending is None:
            return LoginStatus(LoginStage.IDLE)
        return LoginStatus(
            stage=pending.stage,
            phone_hint=mask_phone(pending.phone),
            expires_in_seconds=max(0, int(pending.expires_at - self._clock())),
        )

    async def start(self, *, phone: str, api_id: int, api_hash: str) -> LoginStatus:
        normalized = normalize_phone(phone)
        async with self._lock:
            if self._live_pending() is not None:
                raise LoginError(LoginErrorCode.ALREADY_PENDING)
            await self._discard_locked()
            self._remove_pending_files()
            self._session_path.parent.mkdir(parents=True, exist_ok=True)
            client = self._factory(pending_session_path(self._session_path), api_id, api_hash)
            try:
                await client.connect()
                sent = await client.send_code_request(normalized)
                phone_code_hash = str(sent.phone_code_hash)
            except BaseException as error:
                await self._close_client(client)
                self._remove_pending_files()
                if isinstance(error, (asyncio.CancelledError, KeyboardInterrupt)):
                    raise
                raise _map_error(error) from None
            self._pending = _Pending(
                client=client,
                phone=normalized,
                phone_code_hash=phone_code_hash,
                stage=LoginStage.AWAITING_CODE,
                expires_at=self._clock() + self._ttl,
            )
            self._schedule_expiry()
        return self.status()

    async def submit_code(self, code: str) -> LoginStatus:
        cleaned = (code or "").strip().replace(" ", "")
        if not _CODE.fullmatch(cleaned):
            raise LoginError(LoginErrorCode.CODE_INVALID)
        async with self._lock:
            pending = self._require_pending(LoginStage.AWAITING_CODE)
            try:
                await pending.client.sign_in(
                    pending.phone, cleaned, phone_code_hash=pending.phone_code_hash
                )
            except errors.SessionPasswordNeededError:
                pending.stage = LoginStage.AWAITING_PASSWORD
                return self.status()
            except BaseException as error:
                mapped = _map_error(error)
                await self._after_failure(pending, mapped)
                if isinstance(error, (asyncio.CancelledError, KeyboardInterrupt)):
                    raise
                raise mapped from None
            await self._finish_locked(pending)
        return self.status()

    async def submit_password(self, password: str) -> LoginStatus:
        if not password or len(password) > MAX_PASSWORD_LENGTH:
            raise LoginError(LoginErrorCode.INVALID_INPUT)
        async with self._lock:
            pending = self._require_pending(LoginStage.AWAITING_PASSWORD)
            try:
                await pending.client.sign_in(password=password)
            except BaseException as error:
                mapped = _map_error(error)
                await self._after_failure(pending, mapped)
                if isinstance(error, (asyncio.CancelledError, KeyboardInterrupt)):
                    raise
                raise mapped from None
            await self._finish_locked(pending)
        return self.status()

    async def cancel(self) -> None:
        async with self._lock:
            await self._discard_locked()
            self._remove_pending_files()

    async def shutdown(self) -> None:
        await self.cancel()

    # -- internals -------------------------------------------------------------------

    def _live_pending(self) -> _Pending | None:
        pending = self._pending
        if pending is not None and self._clock() >= pending.expires_at:
            return None
        return pending

    def _require_pending(self, stage: LoginStage) -> _Pending:
        pending = self._live_pending()
        if pending is None or pending.stage is not stage:
            raise LoginError(LoginErrorCode.NOT_STARTED)
        return pending

    async def _after_failure(self, pending: _Pending, error: LoginError) -> None:
        """Decide whether a failed attempt keeps the pending login alive."""
        if error.code in (LoginErrorCode.CODE_INVALID, LoginErrorCode.PASSWORD_INVALID):
            pending.bad_codes += 1
            if pending.bad_codes < MAX_CODE_ATTEMPTS:
                return  # the user may retype it
            # Telegram itself voids the code around here; force a fresh request.
            error.code = LoginErrorCode.TOO_MANY_ATTEMPTS
        await self._discard_locked()
        self._remove_pending_files()

    async def _finish_locked(self, pending: _Pending) -> None:
        """Success: close the client, then move the session into place atomically."""
        await self._discard_locked()
        pending_path = pending_session_path(self._session_path)
        try:
            os.chmod(pending_path, SESSION_MODE)
            os.replace(pending_path, self._session_path)
            os.chmod(self._session_path, SESSION_MODE)
        finally:
            self._remove_pending_files()

    async def _discard_locked(self) -> None:
        pending, self._pending = self._pending, None
        task, self._expiry = self._expiry, None
        if task is not None and task is not asyncio.current_task():
            task.cancel()
        if pending is not None:
            await self._close_client(pending.client)

    @staticmethod
    async def _close_client(client: TelegramLoginClient) -> None:
        with contextlib.suppress(Exception):
            await client.disconnect()

    def _remove_pending_files(self) -> None:
        for path in session_files(pending_session_path(self._session_path)):
            with contextlib.suppress(OSError):
                path.unlink()

    def _schedule_expiry(self) -> None:
        with contextlib.suppress(RuntimeError):
            self._expiry = asyncio.get_running_loop().create_task(self._expire_later())

    async def _expire_later(self) -> None:
        await asyncio.sleep(self._ttl)
        async with self._lock:
            if self._pending is not None and self._clock() >= self._pending.expires_at:
                logger.info("event=telegram_login_expired")
                await self._discard_locked()
                self._remove_pending_files()
