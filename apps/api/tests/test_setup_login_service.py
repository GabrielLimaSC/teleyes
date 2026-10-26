"""S19-02: `TelegramLoginService` against a scripted Telegram (no network)."""

import asyncio
import stat
from pathlib import Path

import pytest
from telethon import errors
from tests.setup_support import (
    API_HASH,
    API_ID,
    CODE,
    PASSWORD,
    PHONE,
    FakeClock,
    FakeTelegramWorld,
    flood_wait,
)

from packages.setup.telegram_login import (
    MAX_CODE_ATTEMPTS,
    LoginError,
    LoginErrorCode,
    LoginStage,
    TelegramLoginService,
    mask_phone,
    normalize_phone,
    pending_session_path,
)


@pytest.fixture
def world() -> FakeTelegramWorld:
    return FakeTelegramWorld()


@pytest.fixture
def clock() -> FakeClock:
    return FakeClock()


@pytest.fixture
def session_path(tmp_path: Path) -> Path:
    return tmp_path / "session" / "teleyes.session"


@pytest.fixture
def service(world: FakeTelegramWorld, clock: FakeClock, session_path: Path) -> TelegramLoginService:
    return TelegramLoginService(
        session_path=session_path, client_factory=world.factory, clock=clock, ttl_seconds=300.0
    )


async def _start(service: TelegramLoginService) -> None:
    await service.start(phone=PHONE, api_id=API_ID, api_hash=API_HASH)


async def _code_of_failure(awaitable: object) -> LoginErrorCode:
    with pytest.raises(LoginError) as raised:
        await awaitable  # type: ignore[misc]
    return raised.value.code


def test_phone_is_normalised_to_e164_and_masked() -> None:
    assert normalize_phone("+55 (11) 98765-4321") == PHONE
    assert mask_phone(PHONE) == "+55•••••••4321"
    for bad in ["", "11987654321", "+0123456", "+55", "abc", "+55 11 98765 4321 9999 999"]:
        with pytest.raises(LoginError) as raised:
            normalize_phone(bad)
        assert raised.value.code is LoginErrorCode.PHONE_INVALID


async def test_happy_path_without_2fa_moves_the_session_into_place_with_0600(
    service: TelegramLoginService, world: FakeTelegramWorld, session_path: Path
) -> None:
    await _start(service)
    assert service.status().stage is LoginStage.AWAITING_CODE
    assert service.status().phone_hint == mask_phone(PHONE)
    assert pending_session_path(session_path).exists()
    assert not session_path.exists()  # nothing real until the login succeeds

    await service.submit_code(CODE)

    assert service.status().stage is LoginStage.IDLE
    assert session_path.exists()
    assert stat.S_IMODE(session_path.stat().st_mode) == 0o600
    assert not pending_session_path(session_path).exists()
    assert world.open_clients == 0
    assert world.clients[0].disconnects >= 1


async def test_two_factor_account_needs_the_password_after_the_code(
    service: TelegramLoginService, world: FakeTelegramWorld, session_path: Path
) -> None:
    world.password = PASSWORD
    await _start(service)

    await service.submit_code(CODE)
    assert service.status().stage is LoginStage.AWAITING_PASSWORD
    assert not session_path.exists()

    assert await _code_of_failure(service.submit_password("wrong")) is (
        LoginErrorCode.PASSWORD_INVALID
    )
    assert service.status().stage is LoginStage.AWAITING_PASSWORD  # may retry

    await service.submit_password(PASSWORD)
    assert service.status().stage is LoginStage.IDLE
    assert session_path.exists()
    assert world.open_clients == 0


@pytest.mark.parametrize(
    ("error", "expected"),
    [
        (errors.PhoneNumberInvalidError(request=None), LoginErrorCode.PHONE_INVALID),
        (errors.PhoneNumberBannedError(request=None), LoginErrorCode.PHONE_BANNED),
        (errors.ApiIdInvalidError(request=None), LoginErrorCode.API_CREDENTIALS_INVALID),
        (ConnectionError("boom: secret-host"), LoginErrorCode.NETWORK),
        (TimeoutError(), LoginErrorCode.NETWORK),
        (RuntimeError("anything else"), LoginErrorCode.UNEXPECTED),
    ],
)
async def test_errors_when_requesting_the_code_are_mapped_and_clean_up(
    service: TelegramLoginService,
    world: FakeTelegramWorld,
    session_path: Path,
    error: BaseException,
    expected: LoginErrorCode,
) -> None:
    world.send_error = error

    assert await _code_of_failure(_start(service)) is expected

    assert service.status().stage is LoginStage.IDLE
    assert world.open_clients == 0
    assert not pending_session_path(session_path).exists()
    assert not session_path.exists()


async def test_a_connection_failure_is_a_network_error(
    service: TelegramLoginService, world: FakeTelegramWorld
) -> None:
    world.connect_error = OSError("no route")

    assert await _code_of_failure(_start(service)) is LoginErrorCode.NETWORK
    assert world.open_clients == 0


async def test_flood_wait_carries_the_time_to_wait(
    service: TelegramLoginService, world: FakeTelegramWorld
) -> None:
    world.send_error = flood_wait(754)

    with pytest.raises(LoginError) as raised:
        await _start(service)

    assert raised.value.code is LoginErrorCode.FLOOD_WAIT
    assert raised.value.retry_after == 754


async def test_wrong_code_may_be_retyped_but_five_misses_discard_the_login(
    service: TelegramLoginService, world: FakeTelegramWorld, session_path: Path
) -> None:
    await _start(service)

    for _ in range(MAX_CODE_ATTEMPTS - 1):
        assert await _code_of_failure(service.submit_code("00000")) is LoginErrorCode.CODE_INVALID
        assert service.status().stage is LoginStage.AWAITING_CODE

    assert await _code_of_failure(service.submit_code("00000")) is LoginErrorCode.TOO_MANY_ATTEMPTS
    assert service.status().stage is LoginStage.IDLE
    assert world.open_clients == 0
    assert not pending_session_path(session_path).exists()
    # The right code no longer works: a fresh code must be requested.
    assert await _code_of_failure(service.submit_code(CODE)) is LoginErrorCode.NOT_STARTED


async def test_expired_code_from_telegram_ends_the_attempt(
    service: TelegramLoginService, world: FakeTelegramWorld
) -> None:
    await _start(service)
    world.code_error = errors.PhoneCodeExpiredError(request=None)

    assert await _code_of_failure(service.submit_code(CODE)) is LoginErrorCode.CODE_EXPIRED

    assert service.status().stage is LoginStage.IDLE
    assert world.open_clients == 0


async def test_code_shape_is_validated_before_anything_is_sent(
    service: TelegramLoginService, world: FakeTelegramWorld
) -> None:
    await _start(service)

    for bad in ["", "abc", "12", "123456789", "12 3x5"]:
        assert await _code_of_failure(service.submit_code(bad)) is LoginErrorCode.CODE_INVALID


async def test_only_one_pending_login_at_a_time(
    service: TelegramLoginService, world: FakeTelegramWorld
) -> None:
    await _start(service)

    assert await _code_of_failure(_start(service)) is LoginErrorCode.ALREADY_PENDING
    assert len(world.clients) == 1


async def test_two_simultaneous_starts_open_one_client(
    service: TelegramLoginService, world: FakeTelegramWorld
) -> None:
    results = await asyncio.gather(_start(service), _start(service), return_exceptions=True)

    assert sum(isinstance(r, LoginError) for r in results) == 1
    assert world.open_clients == 1


async def test_a_pending_login_expires_with_its_ttl_and_closes_the_socket(
    service: TelegramLoginService, world: FakeTelegramWorld, clock: FakeClock
) -> None:
    await _start(service)
    clock.advance(299)
    assert service.status().stage is LoginStage.AWAITING_CODE
    assert 0 < (service.status().expires_in_seconds or 0) <= 1

    clock.advance(2)

    assert service.status().stage is LoginStage.IDLE
    assert await _code_of_failure(service.submit_code(CODE)) is LoginErrorCode.NOT_STARTED
    # A new login can start straight away and replaces the dead client.
    await _start(service)
    assert world.open_clients == 1


async def test_the_expiry_timer_closes_an_abandoned_login_without_any_new_request(
    world: FakeTelegramWorld, session_path: Path
) -> None:
    short = TelegramLoginService(
        session_path=session_path, client_factory=world.factory, ttl_seconds=0.05
    )
    await short.start(phone=PHONE, api_id=API_ID, api_hash=API_HASH)
    assert world.open_clients == 1

    await asyncio.sleep(0.2)

    assert world.open_clients == 0
    assert not pending_session_path(session_path).exists()
    assert short.status().stage is LoginStage.IDLE


async def test_cancel_and_shutdown_close_everything(
    service: TelegramLoginService, world: FakeTelegramWorld, session_path: Path
) -> None:
    await _start(service)

    await service.cancel()

    assert service.status().stage is LoginStage.IDLE
    assert world.open_clients == 0
    assert not pending_session_path(session_path).exists()
    await service.shutdown()  # idempotent


async def test_password_and_code_are_only_accepted_in_their_stage(
    service: TelegramLoginService, world: FakeTelegramWorld
) -> None:
    assert await _code_of_failure(service.submit_code(CODE)) is LoginErrorCode.NOT_STARTED
    assert await _code_of_failure(service.submit_password(PASSWORD)) is LoginErrorCode.NOT_STARTED
    await _start(service)
    assert await _code_of_failure(service.submit_password(PASSWORD)) is LoginErrorCode.NOT_STARTED


async def test_errors_never_quote_the_underlying_message(
    service: TelegramLoginService, world: FakeTelegramWorld
) -> None:
    world.send_error = ConnectionError(f"failed for {PHONE} with {API_HASH}")

    with pytest.raises(LoginError) as raised:
        await _start(service)

    assert PHONE not in str(raised.value) and API_HASH not in str(raised.value)
    assert raised.value.__cause__ is None
    assert raised.value.__suppress_context__ is True
