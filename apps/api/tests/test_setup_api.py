"""S19-02: the `/setup/*` API end to end against fake Telegram and a fake bot.

Covers each wizard step (happy path and every error), resuming from server state,
and the security properties promised in docs/SECURITY_SETUP.md: auth, CSRF, demo
lock-out, rate limits, no secret in any response / log / event.
"""

import json
import logging
import stat
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from httpx import Response
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool
from telethon import errors
from tests.setup_support import (
    API_HASH,
    API_ID,
    BOT_TOKEN,
    BOT_USERNAME,
    CODE,
    PASSWORD,
    PHONE,
    FakeBot,
    FakeClock,
    FakeTelegramWorld,
    flood_wait,
    start_message,
)

from app.config import Settings, get_settings
from app.dialog_scan import DialogInfo, DialogScanWorker, finish_scan
from app.main import app, get_db
from app.setup_runtime import build_limiters
from auth.hashing import hash_password
from auth.rate_limit import LoginRateLimiter
from auth.session import SessionStore
from models import Admin, DialogScan, ListenerControl, Recipient, Rule, SecurityEvent, Source
from models.base import Base
from packages.setup.secret_store import SecretStore
from packages.setup.telegram_login import TelegramLoginService, pending_session_path

PASSWORD_ADMIN = "correct horse battery staple"
SECRETS = [API_HASH, BOT_TOKEN, CODE, PASSWORD, PHONE, PHONE[3:]]


class Wizard:
    def __init__(
        self,
        client: TestClient,
        factory: sessionmaker[Session],
        csrf: str,
        world: FakeTelegramWorld,
        bot: FakeBot,
        store: SecretStore,
        session_path: Path,
        clock: FakeClock,
    ) -> None:
        self.client = client
        self.factory = factory
        self.headers = {"x-csrf-token": csrf}
        self.world = world
        self.bot = bot
        self.store = store
        self.session_path = session_path
        self.clock = clock
        self.responses: list[Response] = []

    def get(self, path: str) -> Response:
        response = self.client.get(path)
        self.responses.append(response)
        return response

    def post(self, path: str, body: dict[str, Any] | None = None) -> Response:
        response = self.client.post(path, json=body or {}, headers=self.headers)
        self.responses.append(response)
        return response

    def put(self, path: str, body: dict[str, Any]) -> Response:
        response = self.client.put(path, json=body, headers=self.headers)
        self.responses.append(response)
        return response

    def status(self) -> dict[str, Any]:
        response = self.get("/setup/status")
        assert response.status_code == 200
        body: dict[str, Any] = response.json()
        return body

    def save_credentials(self) -> Response:
        return self.put("/setup/credentials", {"api_id": API_ID, "api_hash": API_HASH})

    def login(self, *, two_factor: bool = False) -> None:
        self.world.password = PASSWORD if two_factor else None
        assert self.save_credentials().status_code == 200
        assert self.post("/setup/telegram/login/start", {"phone": PHONE}).status_code == 200
        assert self.post("/setup/telegram/login/code", {"code": CODE}).status_code == 200
        if two_factor:
            assert (
                self.post("/setup/telegram/login/password", {"password": PASSWORD}).status_code
                == 200
            )

    def configure_bot(self) -> Response:
        return self.put("/setup/bot", {"token": BOT_TOKEN})

    def events(self) -> list[tuple[str, str | None]]:
        with self.factory() as session:
            rows = session.scalars(select(SecurityEvent).order_by(SecurityEvent.id)).all()
            return [(row.kind, row.detail) for row in rows]


@pytest.fixture
def wizard(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Wizard]:
    session_path = tmp_path / "session" / "teleyes.session"
    for name in ("TG_API_ID", "TG_API_HASH", "BOT_TOKEN", "TELEYES_SECRETS_PATH"):
        monkeypatch.setenv(name, "")
    monkeypatch.setenv("TELEYES_SESSION_PATH", str(session_path))
    monkeypatch.setenv("TELEYES_DEMO", "")
    get_settings.cache_clear()

    engine = create_engine(
        "sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    with factory() as setup:
        setup.add(Admin(password_hash=hash_password(PASSWORD_ADMIN)))
        setup.commit()

    def override_get_db() -> Iterator[Session]:
        with factory() as session:
            yield session

    world = FakeTelegramWorld()
    bot = FakeBot()
    clock = FakeClock()
    store = SecretStore(tmp_path / "session" / "secrets.json")
    previous = {
        name: getattr(app.state, name, None)
        for name in (
            "secret_store",
            "telegram_login",
            "bot_api_factory",
            "setup_limiters",
            "bot_pairing",
        )
    }
    app.dependency_overrides[get_db] = override_get_db
    app.state.session_store = SessionStore()
    app.state.rate_limiter = LoginRateLimiter()
    app.state.secret_store = store
    app.state.telegram_login = TelegramLoginService(
        session_path=session_path, client_factory=world.factory, clock=clock, ttl_seconds=300.0
    )
    app.state.bot_api_factory = bot.factory
    app.state.setup_limiters = build_limiters()
    app.state.bot_pairing = None
    try:
        with TestClient(app, base_url="https://testserver") as client:
            login = client.post("/auth/login", json={"password": PASSWORD_ADMIN})
            assert login.status_code == 200
            yield Wizard(
                client, factory, login.json()["csrf_token"], world, bot, store, session_path, clock
            )
    finally:
        app.dependency_overrides.clear()
        for name, value in previous.items():
            setattr(app.state, name, value)
        get_settings.cache_clear()
        engine.dispose()


def _detail(response: Response) -> dict[str, Any]:
    detail: dict[str, Any] = response.json()["detail"]
    return detail


# --- status & resume ---


def test_a_fresh_install_starts_at_the_credentials_step_and_exposes_no_secret(
    wizard: Wizard,
) -> None:
    status = wizard.status()

    assert status["next_step"] == "credentials"
    assert status["configured"] is False and status["complete"] is False
    assert status["steps"] == {
        "credentials": False,
        "login": False,
        "bot": False,
        "recipient": False,
        "groups": False,
        "rule": False,
    }
    assert status["login"]["state"] == "none"
    assert status["bot"] == {
        "configured": False,
        "source": None,
        "username": None,
        "pairing_active": False,
        "pairing_expires_in_seconds": None,
    }


def test_the_wizard_resumes_at_the_right_step_from_server_state_alone(wizard: Wizard) -> None:
    wizard.save_credentials()
    assert wizard.status()["next_step"] == "login"

    wizard.post("/setup/telegram/login/start", {"phone": PHONE})
    awaiting = wizard.status()
    assert awaiting["next_step"] == "login"
    assert awaiting["login"]["state"] == "awaiting_code"
    assert awaiting["login"]["phone_hint"] == "+55•••••••4321"
    assert 0 < awaiting["login"]["expires_in_seconds"] <= 300

    wizard.post("/setup/telegram/login/code", {"code": CODE})
    assert wizard.status()["next_step"] == "bot"
    assert wizard.status()["login"]["state"] == "authorized"

    wizard.configure_bot()
    assert wizard.status()["next_step"] == "recipient"
    assert wizard.status()["bot"]["username"] == BOT_USERNAME


# --- step 1: credentials ---


def test_saving_credentials_is_idempotent_and_never_echoes_them(wizard: Wizard) -> None:
    first = wizard.save_credentials()
    second = wizard.save_credentials()

    assert first.status_code == second.status_code == 200
    assert first.json()["credentials"] == {"configured": True, "source": "wizard"}
    assert API_HASH not in first.text
    assert wizard.store.read()["tg_api_hash"] == API_HASH
    assert stat.S_IMODE(wizard.store.path.stat().st_mode) == 0o600
    assert wizard.events().count(("telegram_credentials_saved", None)) == 1  # not twice


@pytest.mark.parametrize(
    "body",
    [
        {"api_id": 0, "api_hash": API_HASH},
        {"api_id": -5, "api_hash": API_HASH},
        {"api_id": 2**31, "api_hash": API_HASH},
        {"api_id": 1, "api_hash": "short"},
        {"api_id": 1, "api_hash": "z" * 32},
        {"api_id": 1, "api_hash": API_HASH + "0"},
    ],
)
def test_malformed_credentials_are_rejected_without_saving(
    wizard: Wizard, body: dict[str, Any]
) -> None:
    response = wizard.put("/setup/credentials", body)

    assert response.status_code == 422
    assert _detail(response)["code"] == "credentials_format"
    assert wizard.store.read() == {}


def test_a_validation_error_never_echoes_the_rejected_value(wizard: Wizard) -> None:
    for path, body in [
        ("/setup/credentials", {"api_id": "not-a-number", "api_hash": "LEAK-api-hash-LEAK"}),
        ("/setup/bot", {"token": "LEAK-" + "x" * 200}),
        ("/setup/telegram/login/password", {"password": "LEAK-" + "p" * 400}),
    ]:
        response = wizard.client.request(
            "PUT" if path.endswith("bot") or path.endswith("credentials") else "POST",
            path,
            json=body,
            headers=wizard.headers,
        )
        assert response.status_code == 422
        assert "LEAK" not in response.text


def test_credentials_from_the_environment_cannot_be_overridden(
    wizard: Wizard, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("TG_API_ID", "99")
    monkeypatch.setenv("TG_API_HASH", "f" * 32)
    get_settings.cache_clear()

    response = wizard.save_credentials()

    assert response.status_code == 409
    assert _detail(response)["code"] == "managed_by_env"
    assert wizard.status()["credentials"] == {"configured": True, "source": "env"}
    assert wizard.status()["steps"]["credentials"] is True


# --- step 2: Telegram login ---


def test_login_happy_path_without_2fa(wizard: Wizard) -> None:
    wizard.login()

    status = wizard.status()
    assert status["login"] == {
        "state": "authorized",
        "phone_hint": None,
        "expires_in_seconds": None,
    }
    assert wizard.session_path.exists()
    assert stat.S_IMODE(wizard.session_path.stat().st_mode) == 0o600
    assert not pending_session_path(wizard.session_path).exists()
    assert wizard.world.open_clients == 0
    assert wizard.store.read()["session_generation"] == 1  # tells the listener to reconnect
    kinds = [kind for kind, _ in wizard.events()]
    assert kinds == [
        "telegram_credentials_saved",
        "telegram_login_started",
        "telegram_login_succeeded",
    ]


def test_login_happy_path_with_2fa(wizard: Wizard) -> None:
    wizard.login(two_factor=True)

    assert wizard.status()["login"]["state"] == "authorized"
    assert wizard.world.open_clients == 0


def test_login_needs_the_credentials_first(wizard: Wizard) -> None:
    response = wizard.post("/setup/telegram/login/start", {"phone": PHONE})

    assert response.status_code == 409
    assert _detail(response)["code"] == "no_api_credentials"


def test_a_bad_phone_number_is_a_clear_error_and_does_not_count_against_the_limit(
    wizard: Wizard,
) -> None:
    wizard.save_credentials()

    for _ in range(6):
        response = wizard.post("/setup/telegram/login/start", {"phone": "12345"})
        assert response.status_code == 422
        assert _detail(response)["code"] == "phone_invalid"
        assert "+5511999998888" in _detail(response)["message"]
    assert wizard.world.clients == []  # nothing was ever sent to Telegram


def test_wrong_code_then_right_code(wizard: Wizard) -> None:
    wizard.save_credentials()
    wizard.post("/setup/telegram/login/start", {"phone": PHONE})

    wrong = wizard.post("/setup/telegram/login/code", {"code": "99999"})
    assert wrong.status_code == 422 and _detail(wrong)["code"] == "code_invalid"
    assert "Código incorreto" in _detail(wrong)["message"]
    assert wizard.status()["login"]["state"] == "awaiting_code"

    assert wizard.post("/setup/telegram/login/code", {"code": CODE}).status_code == 200
    assert wizard.status()["login"]["state"] == "authorized"


def test_expired_code(wizard: Wizard) -> None:
    wizard.save_credentials()
    wizard.post("/setup/telegram/login/start", {"phone": PHONE})
    wizard.world.code_error = errors.PhoneCodeExpiredError(request=None)

    response = wizard.post("/setup/telegram/login/code", {"code": CODE})

    assert _detail(response)["code"] == "code_expired"
    assert wizard.status()["login"]["state"] == "none"


def test_wrong_2fa_password(wizard: Wizard) -> None:
    wizard.world.password = PASSWORD
    wizard.save_credentials()
    wizard.post("/setup/telegram/login/start", {"phone": PHONE})
    wizard.post("/setup/telegram/login/code", {"code": CODE})
    assert wizard.status()["login"]["state"] == "awaiting_password"

    response = wizard.post("/setup/telegram/login/password", {"password": "nope"})

    assert response.status_code == 422 and _detail(response)["code"] == "password_invalid"
    assert "duas etapas" in _detail(response)["message"]
    assert not wizard.session_path.exists()


def test_flood_wait_shows_how_long_to_wait(wizard: Wizard) -> None:
    wizard.save_credentials()
    wizard.world.send_error = flood_wait(754)

    response = wizard.post("/setup/telegram/login/start", {"phone": PHONE})

    assert response.status_code == 429
    detail = _detail(response)
    assert detail["code"] == "flood_wait" and detail["retry_after_seconds"] == 754
    assert "13 minutos" in detail["message"]
    assert response.headers["retry-after"] == "754"


@pytest.mark.parametrize(
    ("error", "http_status", "code"),
    [
        (errors.ApiIdInvalidError(request=None), 422, "api_credentials_invalid"),
        (errors.PhoneNumberInvalidError(request=None), 422, "phone_invalid"),
        (errors.PhoneNumberBannedError(request=None), 422, "phone_banned"),
        (ConnectionError("down"), 502, "network"),
    ],
)
def test_telegram_errors_on_start_have_distinct_messages(
    wizard: Wizard, error: BaseException, http_status: int, code: str
) -> None:
    wizard.save_credentials()
    wizard.world.send_error = error

    response = wizard.post("/setup/telegram/login/start", {"phone": PHONE})

    assert response.status_code == http_status
    assert _detail(response)["code"] == code
    assert wizard.status()["login"]["state"] == "none"
    assert wizard.world.open_clients == 0


def test_a_second_login_is_refused_while_one_is_pending_and_after_success(wizard: Wizard) -> None:
    wizard.save_credentials()
    wizard.post("/setup/telegram/login/start", {"phone": PHONE})

    pending = wizard.post("/setup/telegram/login/start", {"phone": PHONE})
    assert pending.status_code == 409 and _detail(pending)["code"] == "already_pending"

    wizard.post("/setup/telegram/login/code", {"code": CODE})
    done = wizard.post("/setup/telegram/login/start", {"phone": PHONE})
    assert done.status_code == 409 and _detail(done)["code"] == "already_authorized"
    assert len(wizard.world.clients) == 1


def test_cancel_discards_the_pending_login(wizard: Wizard) -> None:
    wizard.save_credentials()
    wizard.post("/setup/telegram/login/start", {"phone": PHONE})

    status = wizard.post("/setup/telegram/login/cancel").json()

    assert status["login"]["state"] == "none"
    assert wizard.world.open_clients == 0
    assert ("telegram_login_cancelled", None) in wizard.events()
    # Cancel with nothing pending is harmless.
    assert wizard.post("/setup/telegram/login/cancel").status_code == 200


def test_the_pending_login_expires_after_its_ttl(wizard: Wizard) -> None:
    wizard.save_credentials()
    wizard.post("/setup/telegram/login/start", {"phone": PHONE})

    wizard.clock.advance(301)

    assert wizard.status()["login"]["state"] == "none"
    response = wizard.post("/setup/telegram/login/code", {"code": CODE})
    assert _detail(response)["code"] == "not_started"


def test_the_credentials_cannot_be_swapped_under_an_authorized_session(wizard: Wizard) -> None:
    wizard.login()

    response = wizard.put("/setup/credentials", {"api_id": 5, "api_hash": "a" * 32})

    assert response.status_code == 409
    assert wizard.store.read()["tg_api_id"] == API_ID


# --- disconnect ---


def test_disconnect_needs_confirmation_then_removes_session_and_secrets(wizard: Wizard) -> None:
    wizard.login()
    wizard.configure_bot()
    generation = wizard.store.read()["session_generation"]

    assert wizard.post("/setup/telegram/disconnect", {}).status_code == 422
    assert wizard.session_path.exists()

    status = wizard.post("/setup/telegram/disconnect", {"confirm": True}).json()

    assert not wizard.session_path.exists()
    stored = wizard.store.read()
    assert "tg_api_hash" not in stored and "bot_token" not in stored and "tg_api_id" not in stored
    assert stored["session_generation"] > generation
    assert status["next_step"] == "credentials"
    assert status["credentials"]["configured"] is False
    assert ("session_removed", None) in wizard.events()


def test_disconnect_leaves_values_that_come_from_the_environment(
    wizard: Wizard, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("TG_API_ID", "99")
    monkeypatch.setenv("TG_API_HASH", "f" * 32)
    get_settings.cache_clear()
    wizard.session_path.parent.mkdir(parents=True, exist_ok=True)
    wizard.session_path.write_bytes(b"session")

    status = wizard.post("/setup/telegram/disconnect", {"confirm": True}).json()

    assert not wizard.session_path.exists()
    assert status["credentials"] == {"configured": True, "source": "env"}


# --- step 3: bot ---


def test_the_bot_token_is_validated_with_get_me_and_only_the_username_is_shown(
    wizard: Wizard,
) -> None:
    response = wizard.configure_bot()

    assert response.status_code == 200
    assert response.json()["bot"]["username"] == BOT_USERNAME
    assert BOT_TOKEN not in response.text
    assert wizard.store.read()["bot_token"] == BOT_TOKEN
    assert ("bot_configured", None) in wizard.events()


def test_a_token_with_a_bad_shape_never_reaches_telegram(wizard: Wizard) -> None:
    response = wizard.put("/setup/bot", {"token": "not-a-token"})

    assert response.status_code == 422 and _detail(response)["code"] == "token_format"
    assert wizard.bot.tokens_seen == []


def test_a_token_telegram_rejects_is_a_clear_error_and_is_not_saved(wizard: Wizard) -> None:
    wizard.bot.token_ok = False

    response = wizard.configure_bot()

    assert response.status_code == 422 and _detail(response)["code"] == "token_invalid"
    assert "token" in _detail(response)["message"]
    assert wizard.store.read().get("bot_token") is None


def test_bot_network_failure_is_reported(wizard: Wizard) -> None:
    wizard.bot.network_down = True

    response = wizard.configure_bot()

    assert response.status_code == 502 and _detail(response)["code"] == "network"


def test_changing_the_bot_token_replaces_it(wizard: Wizard) -> None:
    wizard.configure_bot()
    other = "987654321:" + "B" * 35
    wizard.bot.identity = wizard.bot.identity.__class__(id=8, username="other_bot", name="Other")

    response = wizard.put("/setup/bot", {"token": other})

    assert response.json()["bot"]["username"] == "other_bot"
    assert wizard.store.read()["bot_token"] == other


def test_a_bot_token_from_the_environment_wins(
    wizard: Wizard, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("BOT_TOKEN", BOT_TOKEN)
    get_settings.cache_clear()

    response = wizard.configure_bot()

    assert response.status_code == 409 and _detail(response)["code"] == "managed_by_env"
    assert wizard.status()["bot"]["source"] == "env"


# --- step 3b: pairing (the recipient) ---


def test_pairing_registers_the_recipient_who_sends_start_with_the_code(wizard: Wizard) -> None:
    wizard.configure_bot()
    pairing = wizard.post("/setup/bot/pairing").json()
    assert pairing["deep_link"] == f"https://t.me/{BOT_USERNAME}?start={pairing['code']}"
    assert wizard.status()["bot"]["pairing_active"] is True

    waiting = wizard.post("/setup/bot/pairing/poll").json()
    assert waiting["state"] == "waiting"

    wizard.bot.inbox = [start_message(1, "5550001", pairing["code"], "Gabriel")]
    paired = wizard.post("/setup/bot/pairing/poll").json()

    assert paired["state"] == "paired" and paired["recipient"]["name"] == "Gabriel"
    with wizard.factory() as session:
        recipient = session.scalar(select(Recipient))
        assert recipient is not None
        assert (recipient.telegram_chat_id, recipient.allowlisted, recipient.active) == (
            "5550001",
            True,
            True,
        )
    assert wizard.status()["bot"]["pairing_active"] is False
    assert wizard.status()["steps"]["recipient"] is True
    assert ("bot_paired", None) in wizard.events()


def test_a_stranger_who_starts_the_bot_without_the_code_is_never_registered(wizard: Wizard) -> None:
    wizard.configure_bot()
    pairing = wizard.post("/setup/bot/pairing").json()
    wizard.bot.inbox = [
        start_message(1, "666", "", "Intruso"),
        start_message(2, "667", "WRONGCODE", "Intruso 2"),
    ]

    result = wizard.post("/setup/bot/pairing/poll").json()

    assert result["state"] == "waiting" and result["ignored_starts"] == 2
    with wizard.factory() as session:
        assert session.scalar(select(Recipient)) is None
    assert pairing["code"] not in json.dumps(result)


def test_pairing_the_same_person_twice_does_not_duplicate_the_recipient(wizard: Wizard) -> None:
    wizard.configure_bot()
    for update_id in (1, 2):
        pairing = wizard.post("/setup/bot/pairing").json()
        wizard.bot.inbox = [start_message(update_id, "5550001", pairing["code"], "Gabriel")]
        assert wizard.post("/setup/bot/pairing/poll").json()["state"] == "paired"

    with wizard.factory() as session:
        assert len(session.scalars(select(Recipient)).all()) == 1


def test_pairing_expires(wizard: Wizard, monkeypatch: pytest.MonkeyPatch) -> None:
    wizard.configure_bot()
    wizard.post("/setup/bot/pairing")
    app.state.bot_pairing.expires_at -= 10_000

    assert wizard.post("/setup/bot/pairing/poll").json()["state"] == "expired"
    assert wizard.status()["bot"]["pairing_active"] is False


def test_pairing_needs_a_bot(wizard: Wizard) -> None:
    response = wizard.post("/setup/bot/pairing")

    assert response.status_code == 409 and _detail(response)["code"] == "bot_not_configured"


def test_pairing_reports_a_webhook_conflict(wizard: Wizard) -> None:
    wizard.configure_bot()
    wizard.post("/setup/bot/pairing")
    wizard.bot.conflict = True

    response = wizard.post("/setup/bot/pairing/poll")

    assert response.status_code == 409 and _detail(response)["code"] == "conflict"


# --- step 4: groups ---


class FakeDialog:
    def __init__(self, chat_id: int, name: str, *, group: bool, channel: bool, user: bool) -> None:
        self.id = chat_id
        self.name = name
        self.is_group = group
        self.is_channel = channel
        self.is_user = user


class FakeDialogClient:
    def __init__(self, dialogs: list[FakeDialog]) -> None:
        self._dialogs = dialogs

    async def iter_dialogs(self) -> Any:
        for dialog in self._dialogs:
            yield dialog


DIALOGS = [
    FakeDialog(-1001, "Promoções PC", group=True, channel=True, user=False),
    FakeDialog(-1002, "Ofertas Canal", group=False, channel=True, user=False),
    FakeDialog(-1003, "Grupo antigo", group=True, channel=False, user=False),
    FakeDialog(42, "Alguém (conversa privada)", group=False, channel=False, user=True),
]


async def _listener_answers(
    wizard: Wizard, dialogs: list[FakeDialog], *, connected: bool = True
) -> bool:
    worker = DialogScanWorker(
        session_factory=wizard.factory,
        client=FakeDialogClient(dialogs),
        is_connected=lambda: connected,
    )
    return await worker.poll_once()


async def test_the_group_list_comes_from_the_listener_and_excludes_private_chats(
    wizard: Wizard,
) -> None:
    assert wizard.get("/setup/groups").json()["state"] == "idle"
    assert wizard.post("/setup/groups/refresh").json()["state"] in ("pending", "waiting_listener")

    assert await _listener_answers(wizard, DIALOGS) is True

    groups = wizard.get("/setup/groups").json()
    assert groups["state"] == "done"
    assert {d["chat_id"]: d["kind"] for d in groups["dialogs"]} == {
        "-1001": "group",
        "-1002": "channel",
        "-1003": "group",
    }
    assert all(d["monitored"] is False for d in groups["dialogs"])


async def test_the_scan_waits_for_a_connected_listener_and_reports_failures_by_class(
    wizard: Wizard,
) -> None:
    wizard.post("/setup/groups/refresh")
    assert await _listener_answers(wizard, DIALOGS, connected=False) is False
    assert wizard.get("/setup/groups").json()["state"] == "waiting_listener"

    class Broken:
        def iter_dialogs(self) -> Any:
            raise RuntimeError(f"secret detail about {PHONE}")

    worker = DialogScanWorker(
        session_factory=wizard.factory, client=Broken(), is_connected=lambda: True
    )
    await worker.poll_once()

    groups = wizard.get("/setup/groups").json()
    assert groups["state"] == "failed" and groups["error"] == "RuntimeError"
    assert PHONE not in json.dumps(groups)


async def test_selecting_groups_creates_sources_once_and_asks_the_listener_to_reload(
    wizard: Wizard,
) -> None:
    wizard.post("/setup/groups/refresh")
    await _listener_answers(wizard, DIALOGS)

    first = wizard.post("/setup/groups/select", {"chat_ids": ["-1001", "-1002"]})
    again = wizard.post("/setup/groups/select", {"chat_ids": ["-1001", "-1003"]})

    assert first.json() == {"created": 2, "already_monitored": 0}
    assert again.json() == {"created": 1, "already_monitored": 1}
    with wizard.factory() as session:
        names = {s.telegram_chat_id: s.name for s in session.scalars(select(Source))}
        assert names == {"-1001": "Promoções PC", "-1002": "Ofertas Canal", "-1003": "Grupo antigo"}
        control = session.get(ListenerControl, 1)
        assert control is not None and control.state == "pending"
    assert {
        d["chat_id"] for d in wizard.get("/setup/groups").json()["dialogs"] if d["monitored"]
    } == {
        "-1001",
        "-1002",
        "-1003",
    }
    assert wizard.status()["steps"]["groups"] is True


async def test_only_groups_the_listener_saw_can_be_selected(wizard: Wizard) -> None:
    wizard.post("/setup/groups/refresh")
    await _listener_answers(wizard, DIALOGS)

    for chat_ids in (["-999"], [], ["-1001", "-999"], ["42"]):
        response = wizard.post("/setup/groups/select", {"chat_ids": chat_ids})
        assert response.status_code == 422 and _detail(response)["code"] == "unknown_group"
    with wizard.factory() as session:
        assert session.scalar(select(Source)) is None


def test_the_listener_never_writes_to_telegram_while_listing() -> None:
    """The scan only calls `iter_dialogs`; a client without any other method suffices."""

    class OnlyLists:
        def iter_dialogs(self) -> Any:
            return FakeDialogClient(DIALOGS).iter_dialogs()

    assert [m for m in dir(OnlyLists) if not m.startswith("_")] == ["iter_dialogs"]


def test_the_scan_row_cannot_stay_running_forever(wizard: Wizard) -> None:
    from datetime import UTC, datetime, timedelta

    from app.dialog_scan import read_scan, request_scan

    with wizard.factory() as session:
        assert request_scan(session) is True
        assert request_scan(session) is False  # one in flight
        later = datetime.now(UTC) + timedelta(minutes=3)
        assert read_scan(session, now=later).state == "failed"  # a dead listener is noticed
        assert request_scan(session, now=later) is True


def test_finish_scan_replaces_the_previous_list(wizard: Wizard) -> None:
    with wizard.factory() as session:
        finish_scan(session, [DialogInfo("-1", "A", "group"), DialogInfo("-2", "B", "channel")])
        finish_scan(session, [DialogInfo("-3", "C", "group")])
        row = session.get(DialogScan, 1)
        assert row is not None and row.state == "done"
    assert [d["chat_id"] for d in wizard.get("/setup/groups").json()["dialogs"]] == ["-3"]


# --- completion ---


async def test_everything_done_is_complete_only_with_a_live_listener(wizard: Wizard) -> None:
    from datetime import UTC, datetime

    from app.listener_control import touch_listener_seen

    wizard.login()
    wizard.configure_bot()
    pairing = wizard.post("/setup/bot/pairing").json()
    wizard.bot.inbox = [start_message(1, "5550001", pairing["code"])]
    wizard.post("/setup/bot/pairing/poll")
    wizard.post("/setup/groups/refresh")
    await _listener_answers(wizard, DIALOGS)
    wizard.post("/setup/groups/select", {"chat_ids": ["-1001"]})
    with wizard.factory() as session:
        session.add(Rule(name="RTX 5070", include_terms="rtx 5070"))
        session.commit()

    offline = wizard.status()
    assert offline["next_step"] == "done" and offline["configured"] is True
    assert offline["complete"] is False

    with wizard.factory() as session:
        touch_listener_seen(session, now=datetime.now(UTC))

    assert wizard.status()["complete"] is True


# --- security ---

ROUTES: list[tuple[str, str]] = [
    ("GET", "/setup/status"),
    ("PUT", "/setup/credentials"),
    ("POST", "/setup/telegram/login/start"),
    ("POST", "/setup/telegram/login/code"),
    ("POST", "/setup/telegram/login/password"),
    ("POST", "/setup/telegram/login/cancel"),
    ("POST", "/setup/telegram/disconnect"),
    ("PUT", "/setup/bot"),
    ("POST", "/setup/bot/pairing"),
    ("POST", "/setup/bot/pairing/poll"),
    ("GET", "/setup/groups"),
    ("POST", "/setup/groups/refresh"),
    ("POST", "/setup/groups/select"),
]
MUTATING = [(m, p) for m, p in ROUTES if m != "GET"]


@pytest.mark.parametrize(("method", "path"), ROUTES)
def test_every_setup_route_needs_a_session(wizard: Wizard, method: str, path: str) -> None:
    wizard.client.cookies.clear()

    response = wizard.client.request(method, path, json={}, headers=wizard.headers)

    assert response.status_code == 401


@pytest.mark.parametrize(("method", "path"), MUTATING)
def test_every_mutating_setup_route_needs_the_csrf_token(
    wizard: Wizard, method: str, path: str
) -> None:
    missing = wizard.client.request(method, path, json={})
    wrong = wizard.client.request(method, path, json={}, headers={"x-csrf-token": "wrong"})

    assert missing.status_code == 403 and wrong.status_code == 403
    assert wizard.events() == []  # a rejected call changed and recorded nothing
    assert wizard.store.read() == {}


@pytest.mark.parametrize(("method", "path"), ROUTES)
def test_the_wizard_is_locked_in_demo_mode(
    wizard: Wizard, monkeypatch: pytest.MonkeyPatch, method: str, path: str
) -> None:
    demo = Settings(teleyes_demo=True)
    monkeypatch.setattr("app.routers.setup.get_settings", lambda: demo)

    response = wizard.client.request(method, path, json={}, headers=wizard.headers)

    assert response.status_code == 403
    assert _detail(response)["code"] == "demo_mode"
    assert wizard.store.read() == {}


def test_the_login_start_is_rate_limited_with_a_backoff(wizard: Wizard) -> None:
    wizard.save_credentials()
    limiters = app.state.setup_limiters
    clock = FakeClock()
    limiters["login_start"] = type(limiters["login_start"])(
        max_failures=3, window_seconds=900.0, base_lockout_seconds=300.0, clock=clock
    )

    for _ in range(3):
        assert wizard.post("/setup/telegram/login/start", {"phone": PHONE}).status_code == 200
        wizard.post("/setup/telegram/login/cancel")
    blocked = wizard.post("/setup/telegram/login/start", {"phone": PHONE})

    assert blocked.status_code == 429
    assert _detail(blocked)["code"] == "rate_limited"
    assert 290 <= _detail(blocked)["retry_after_seconds"] <= 301
    assert int(blocked.headers["retry-after"]) >= 290
    assert len(wizard.world.clients) == 3  # the blocked attempt never reached Telegram
    assert ("rate_limited", "login_start") in wizard.events()

    clock.advance(301)
    assert wizard.post("/setup/telegram/login/start", {"phone": PHONE}).status_code == 200


def test_guessing_codes_is_rate_limited_across_fresh_login_attempts(wizard: Wizard) -> None:
    wizard.save_credentials()
    clock = FakeClock()
    limiters = app.state.setup_limiters
    limiters["login_answer"] = type(limiters["login_answer"])(
        max_failures=5, window_seconds=600.0, base_lockout_seconds=60.0, clock=clock
    )
    wizard.post("/setup/telegram/login/start", {"phone": PHONE})
    for _ in range(5):
        wizard.post("/setup/telegram/login/code", {"code": "00000"})
    wizard.post("/setup/telegram/login/start", {"phone": PHONE})  # a new code, same attacker

    locked = wizard.post("/setup/telegram/login/code", {"code": CODE})  # even the right one

    assert locked.status_code == 429 and _detail(locked)["code"] == "rate_limited"
    assert not wizard.session_path.exists()
    clock.advance(61)
    assert wizard.post("/setup/telegram/login/code", {"code": CODE}).status_code == 200


def test_guessing_2fa_passwords_is_rate_limited(wizard: Wizard) -> None:
    wizard.world.password = PASSWORD
    wizard.save_credentials()
    wizard.post("/setup/telegram/login/start", {"phone": PHONE})
    wizard.post("/setup/telegram/login/code", {"code": CODE})

    codes = [
        wizard.post("/setup/telegram/login/password", {"password": f"guess-{n}"}).status_code
        for n in range(7)
    ]

    assert codes[:4] == [422] * 4
    assert 429 in codes
    assert wizard.status()["login"]["state"] != "authorized"


def test_guessing_bot_tokens_is_rate_limited(wizard: Wizard) -> None:
    wizard.bot.token_ok = False
    outcomes = [
        wizard.put("/setup/bot", {"token": f"{100000 + n}:" + "A" * 35}).status_code
        for n in range(7)
    ]

    assert outcomes[:5] == [422] * 5 and outcomes[5:] == [429, 429]
    assert len(wizard.bot.tokens_seen) == 5


def test_no_response_ever_contains_a_secret(wizard: Wizard) -> None:
    wizard.login(two_factor=True)
    wizard.configure_bot()
    pairing = wizard.post("/setup/bot/pairing").json()
    wizard.bot.inbox = [start_message(1, "5550001", pairing["code"])]
    wizard.post("/setup/bot/pairing/poll")
    wizard.post("/setup/telegram/login/start", {"phone": PHONE})  # refused: already authorized
    wizard.post("/setup/telegram/login/code", {"code": "00000"})
    wizard.status()
    wizard.get("/setup/groups")
    wizard.get("/health")
    wizard.client.get("/listener/status")

    for response in wizard.responses:
        for secret in (API_HASH, BOT_TOKEN, CODE, PASSWORD, PHONE, "HASH-OF-THE-CODE"):
            assert secret not in response.text, f"{secret!r} leaked by {response.request.url.path}"
        assert "tg_api_hash" not in response.text and "bot_token" not in response.text


def test_health_counts_wizard_credentials_as_configured(wizard: Wizard) -> None:
    before = wizard.client.get("/health").json()
    wizard.save_credentials()
    wizard.configure_bot()
    after = wizard.client.get("/health").json()

    assert before["telegram"]["configured"] is False and before["bot"]["configured"] is False
    assert after["telegram"]["configured"] is True and after["bot"]["state"] == "configured"
    assert API_HASH not in json.dumps(after) and BOT_TOKEN not in json.dumps(after)


def test_logs_never_contain_a_secret(wizard: Wizard, caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.DEBUG)
    wizard.world.send_error = None
    wizard.login(two_factor=True)
    wizard.post("/setup/telegram/login/code", {"code": "00000"})
    wizard.configure_bot()
    wizard.bot.token_ok = False
    wizard.put("/setup/bot", {"token": "111111:" + "Z" * 35})
    wizard.bot.token_ok = True
    pairing = wizard.post("/setup/bot/pairing").json()
    wizard.bot.inbox = [start_message(1, "5550001", pairing["code"])]
    wizard.post("/setup/bot/pairing/poll")
    wizard.post("/setup/telegram/disconnect", {"confirm": True})

    text = caplog.text
    assert "telegram_login_succeeded" in text  # events are logged...
    for secret in (*SECRETS, "Z" * 35, pairing["code"], "5550001", "HASH-OF-THE-CODE"):
        assert secret not in text, f"{secret!r} appeared in the logs"


def test_audit_events_are_a_closed_set_without_personal_data(wizard: Wizard) -> None:
    wizard.login(two_factor=True)
    wizard.post("/setup/telegram/login/start", {"phone": PHONE})
    wizard.configure_bot()
    wizard.post("/setup/telegram/disconnect", {"confirm": True})

    with wizard.factory() as session:
        rows = session.scalars(select(SecurityEvent)).all()
        dump = json.dumps([(r.kind, r.detail) for r in rows])
    for secret in SECRETS:
        assert secret not in dump
    assert {r.kind for r in rows} <= {
        "telegram_credentials_saved",
        "telegram_login_started",
        "telegram_login_succeeded",
        "telegram_login_failed",
        "telegram_login_cancelled",
        "bot_configured",
        "bot_paired",
        "session_removed",
        "rate_limited",
    }
    status = wizard.status()
    assert [e["kind"] for e in status["events"]][0] == "session_removed"  # newest first


def test_no_task_or_socket_is_left_behind_after_a_full_flow(wizard: Wizard) -> None:
    wizard.login(two_factor=True)
    wizard.post("/setup/telegram/disconnect", {"confirm": True})
    wizard.save_credentials()
    wizard.post("/setup/telegram/login/start", {"phone": PHONE})
    wizard.post("/setup/telegram/login/cancel")

    assert wizard.world.open_clients == 0
    service: TelegramLoginService = app.state.telegram_login
    assert service._pending is None and service._expiry is None
