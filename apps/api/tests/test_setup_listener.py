"""S19-02: the listener idles until the wizard finishes, then follows its changes."""

import asyncio
import importlib.util
import sys
from collections.abc import Iterator
from pathlib import Path
from types import ModuleType

import pytest
from tests.setup_support import API_HASH, API_ID, BOT_TOKEN

from packages.setup.secret_store import (
    KEY_API_HASH,
    KEY_API_ID,
    KEY_BOT_TOKEN,
    SecretStore,
)

SCRIPT = Path(__file__).resolve().parents[3] / "scripts" / "run_listener.py"


@pytest.fixture
def listener(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[ModuleType]:
    session = tmp_path / "session" / "teleyes.session"
    for name in ("TG_API_ID", "TG_API_HASH", "BOT_TOKEN", "TELEYES_SECRETS_PATH"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("TELEYES_SESSION_PATH", str(session))
    spec = importlib.util.spec_from_file_location("run_listener_under_test", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    monkeypatch.setattr(module, "CONFIG_POLL_SECONDS", 0.01)
    monkeypatch.setattr(module, "load_dotenv", lambda *a, **k: None)
    yield module
    sys.modules.pop(spec.name, None)


def _store(module: ModuleType) -> SecretStore:
    store: SecretStore = SecretStore(module.SESSION_PATH.parent / "secrets.json")
    return store


def _finish_the_wizard(module: ModuleType) -> None:
    store = _store(module)
    store.update({KEY_API_ID: API_ID, KEY_API_HASH: API_HASH, KEY_BOT_TOKEN: BOT_TOKEN})
    module.SESSION_PATH.write_bytes(b"session")
    store.bump_generation()


async def test_the_listener_stays_idle_until_the_wizard_has_everything_then_serves(
    listener: ModuleType, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    stops: list[asyncio.Event] = []
    served: list[tuple[int, str, str]] = []

    async def fake_serve(
        api_id: int, api_hash: str, bot_token: str, stop_event: asyncio.Event
    ) -> int:
        served.append((api_id, api_hash, bot_token))
        stops[0].set()  # end the process after the first session
        return 0

    monkeypatch.setattr(listener, "_serve", fake_serve)
    monkeypatch.setattr(
        listener, "install_stop_signal_handlers", lambda _loop, event: stops.append(event)
    )
    listener.SESSION_PATH.parent.mkdir(parents=True)
    main = asyncio.create_task(listener.main())

    await asyncio.sleep(0.1)
    assert served == [] and not main.done()  # nothing configured: idle, no connection attempt

    _finish_the_wizard(listener)
    assert await asyncio.wait_for(main, timeout=5) == 0

    assert served == [(API_ID, API_HASH, BOT_TOKEN)]
    printed = capsys.readouterr().out
    assert "not_configured" in printed
    assert API_HASH not in printed and BOT_TOKEN not in printed


async def test_a_credentials_change_rebuilds_the_session(
    listener: ModuleType, monkeypatch: pytest.MonkeyPatch
) -> None:
    stops: list[asyncio.Event] = []
    sessions = 0

    async def fake_serve(
        api_id: int, api_hash: str, bot_token: str, stop_event: asyncio.Event
    ) -> int:
        nonlocal sessions
        sessions += 1
        if sessions == 2:
            stops[0].set()  # the process stops during the second session
        await stop_event.wait()
        return 0

    monkeypatch.setattr(listener, "_serve", fake_serve)
    monkeypatch.setattr(
        listener, "install_stop_signal_handlers", lambda _loop, event: stops.append(event)
    )
    listener.SESSION_PATH.parent.mkdir(parents=True)
    _finish_the_wizard(listener)
    main = asyncio.create_task(listener.main())
    await asyncio.sleep(0.1)
    assert sessions == 1

    _store(listener).bump_generation()  # e.g. "Desconectar Telegram" then a new login

    assert await asyncio.wait_for(main, timeout=5) == 0
    assert sessions == 2


async def test_removing_the_session_stops_the_connection_and_goes_back_to_idle(
    listener: ModuleType, monkeypatch: pytest.MonkeyPatch
) -> None:
    stops: list[asyncio.Event] = []
    sessions = 0

    async def fake_serve(
        api_id: int, api_hash: str, bot_token: str, stop_event: asyncio.Event
    ) -> int:
        nonlocal sessions
        sessions += 1
        await stop_event.wait()
        return 0

    monkeypatch.setattr(listener, "_serve", fake_serve)
    monkeypatch.setattr(
        listener, "install_stop_signal_handlers", lambda _loop, event: stops.append(event)
    )
    listener.SESSION_PATH.parent.mkdir(parents=True)
    _finish_the_wizard(listener)
    main = asyncio.create_task(listener.main())
    await asyncio.sleep(0.1)
    assert sessions == 1

    listener.SESSION_PATH.unlink()
    store = _store(listener)
    store.clear_secrets()
    store.bump_generation()
    await asyncio.sleep(0.2)

    assert sessions == 1 and not main.done()  # idle again, not reconnecting
    stops[0].set()
    assert await asyncio.wait_for(main, timeout=5) == 0


async def test_a_process_stop_ends_a_running_session_without_restarting(
    listener: ModuleType, monkeypatch: pytest.MonkeyPatch
) -> None:
    stops: list[asyncio.Event] = []
    sessions = 0

    async def fake_serve(
        api_id: int, api_hash: str, bot_token: str, stop_event: asyncio.Event
    ) -> int:
        nonlocal sessions
        sessions += 1
        await stop_event.wait()
        return 0

    monkeypatch.setattr(listener, "_serve", fake_serve)
    monkeypatch.setattr(
        listener, "install_stop_signal_handlers", lambda _loop, event: stops.append(event)
    )
    listener.SESSION_PATH.parent.mkdir(parents=True)
    _finish_the_wizard(listener)
    main = asyncio.create_task(listener.main())
    await asyncio.sleep(0.1)

    stops[0].set()

    assert await asyncio.wait_for(main, timeout=5) == 0
    assert sessions == 1


async def test_environment_credentials_keep_working_without_the_wizard(
    listener: ModuleType, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The author's own deployment and `.env` users: env wins, no secrets file needed."""
    monkeypatch.setenv("TG_API_ID", "777")
    monkeypatch.setenv("TG_API_HASH", "c" * 32)
    monkeypatch.setenv("BOT_TOKEN", "555:" + "D" * 35)
    listener.SESSION_PATH.parent.mkdir(parents=True)
    listener.SESSION_PATH.write_bytes(b"session")
    seen: list[tuple[int, str, str]] = []

    async def fake_serve(
        api_id: int, api_hash: str, bot_token: str, stop_event: asyncio.Event
    ) -> int:
        seen.append((api_id, api_hash, bot_token))
        return 0

    monkeypatch.setattr(listener, "_serve", fake_serve)
    monkeypatch.setattr(listener, "install_stop_signal_handlers", lambda _loop, _event: None)

    assert await asyncio.wait_for(listener.main(), timeout=5) == 0
    assert seen == [(777, "c" * 32, "555:" + "D" * 35)]
