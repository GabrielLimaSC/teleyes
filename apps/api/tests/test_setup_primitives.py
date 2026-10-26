"""S19-02: secret store, credential resolution, Bot API client and the rate limiter."""

import json
import logging
import os
import stat
import threading
from pathlib import Path

import httpx
import pytest
from tests.setup_support import API_HASH, API_ID, BOT_TOKEN, FakeClock

from auth.rate_limit import EscalatingRateLimiter
from packages.setup.bot_api import (
    BotApiError,
    BotApiErrorCode,
    HttpBotApi,
    is_valid_token,
)
from packages.setup.credentials import (
    fingerprint,
    not_ready_reason,
    remove_session_files,
    resolve_credentials,
    secrets_path_for,
)
from packages.setup.secret_store import KEY_API_HASH, KEY_API_ID, KEY_BOT_TOKEN, SecretStore

# --- SecretStore -----------------------------------------------------------------------


def test_store_creates_a_private_directory_and_a_0600_file(tmp_path: Path) -> None:
    store = SecretStore(tmp_path / "vault" / "secrets.json")

    store.update({KEY_API_ID: API_ID, KEY_API_HASH: API_HASH})

    assert stat.S_IMODE(store.path.parent.stat().st_mode) == 0o700
    assert stat.S_IMODE(store.path.stat().st_mode) == 0o600
    assert store.read() == {KEY_API_ID: API_ID, KEY_API_HASH: API_HASH}


def test_store_writes_atomically_and_leaves_no_temporary_file(tmp_path: Path) -> None:
    store = SecretStore(tmp_path / "secrets.json")
    store.update({KEY_BOT_TOKEN: BOT_TOKEN})
    store.update({KEY_BOT_TOKEN: None})

    leftovers = [p.name for p in tmp_path.iterdir() if p.name.endswith(".tmp")]
    assert leftovers == []
    assert store.read() == {}


def test_a_failed_write_keeps_the_previous_contents(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = SecretStore(tmp_path / "secrets.json")
    store.update({KEY_API_ID: 1})

    def explode(*_args: object, **_kwargs: object) -> None:
        raise OSError("disk full")

    monkeypatch.setattr(os, "replace", explode)
    with pytest.raises(OSError):
        store.update({KEY_API_ID: 2})
    monkeypatch.undo()

    assert store.read() == {KEY_API_ID: 1}
    assert [p.name for p in tmp_path.iterdir() if p.name.endswith(".tmp")] == []


def test_concurrent_updates_never_lose_one_another(tmp_path: Path) -> None:
    store = SecretStore(tmp_path / "secrets.json")
    workers = [
        threading.Thread(target=lambda: [store.bump_generation() for _ in range(10)])
        for _ in range(8)
    ]
    for worker in workers:
        worker.start()
    for worker in workers:
        worker.join()

    assert store.read()["session_generation"] == 80


def test_a_malformed_or_foreign_file_reads_as_empty_and_unknown_keys_are_refused(
    tmp_path: Path,
) -> None:
    path = tmp_path / "secrets.json"
    path.write_text("{not json")
    store = SecretStore(path)
    assert store.read() == {}

    path.write_text(json.dumps({"tg_api_id": 5, "something_else": "x"}))
    assert store.read() == {"tg_api_id": 5}
    with pytest.raises(ValueError):
        store.update({"something_else": "x"})


def test_clear_secrets_keeps_only_the_change_counter(tmp_path: Path) -> None:
    store = SecretStore(tmp_path / "secrets.json")
    store.update({KEY_API_ID: API_ID, KEY_API_HASH: API_HASH, KEY_BOT_TOKEN: BOT_TOKEN})
    store.bump_generation()

    store.clear_secrets()

    assert store.read() == {"session_generation": 1}


# --- credentials -----------------------------------------------------------------------


def test_environment_wins_over_the_wizard_store_and_the_api_pair_is_not_mixed(
    tmp_path: Path,
) -> None:
    store = SecretStore(tmp_path / "secrets.json")
    store.update({KEY_API_ID: 111, KEY_API_HASH: "b" * 32, KEY_BOT_TOKEN: BOT_TOKEN})

    both = resolve_credentials(store, env_api_id="222", env_api_hash="a" * 32)
    assert (both.api_id, both.api_source) == (222, "env")
    assert both.bot_token == BOT_TOKEN and both.bot_source == "wizard"

    half = resolve_credentials(store, env_api_id="222", env_api_hash="")
    assert (half.api_id, half.api_hash, half.api_source) == (111, "b" * 32, "wizard")

    env_bot = resolve_credentials(store, env_bot_token="999:" + "x" * 35)
    assert env_bot.bot_source == "env" and env_bot.bot_username is None


def test_nothing_configured_resolves_to_nothing(tmp_path: Path) -> None:
    creds = resolve_credentials(SecretStore(tmp_path / "secrets.json"), env_api_id="")

    assert not creds.has_api and not creds.has_bot
    assert creds.api_source is None and creds.bot_source is None


def test_credentials_repr_never_contains_a_secret(tmp_path: Path) -> None:
    store = SecretStore(tmp_path / "secrets.json")
    store.update({KEY_API_ID: API_ID, KEY_API_HASH: API_HASH, KEY_BOT_TOKEN: BOT_TOKEN})
    creds = resolve_credentials(store)

    for text in (repr(creds), str(creds), f"{creds}"):
        assert API_HASH not in text and BOT_TOKEN not in text


def test_listener_gate_names_what_is_missing_and_the_fingerprint_tracks_changes(
    tmp_path: Path,
) -> None:
    session = tmp_path / "teleyes.session"
    store = SecretStore(tmp_path / "secrets.json")
    creds = resolve_credentials(store)
    assert "TG_API_ID" in (not_ready_reason(creds, session) or "")

    store.update({KEY_API_ID: API_ID, KEY_API_HASH: API_HASH})
    creds = resolve_credentials(store)
    assert "BOT_TOKEN" in (not_ready_reason(creds, session) or "")

    store.update({KEY_BOT_TOKEN: BOT_TOKEN})
    creds = resolve_credentials(store)
    assert "Sessão" in (not_ready_reason(creds, session) or "")
    before = fingerprint(creds, session)

    session.write_bytes(b"x")
    assert not_ready_reason(creds, session) is None
    assert fingerprint(creds, session) != before

    ready = fingerprint(creds, session)
    store.bump_generation()
    assert fingerprint(resolve_credentials(store), session) != ready
    assert API_HASH not in ready and BOT_TOKEN not in ready


def test_removing_the_session_deletes_the_file_and_sqlite_side_files(tmp_path: Path) -> None:
    session = tmp_path / "teleyes.session"
    for suffix in ("", "-journal", "-wal"):
        (tmp_path / f"teleyes.session{suffix}").write_bytes(b"x")

    assert remove_session_files(session) is True
    assert list(tmp_path.iterdir()) == []
    assert remove_session_files(session) is False


def test_secrets_live_beside_the_session_unless_told_otherwise(tmp_path: Path) -> None:
    session = tmp_path / "s" / "teleyes.session"
    assert secrets_path_for(session, {}) == tmp_path / "s" / "secrets.json"
    assert secrets_path_for(session, {"TELEYES_SECRETS_PATH": "/x/y.json"}) == Path("/x/y.json")


# --- Bot API client -------------------------------------------------------------------------


def _bot_api(handler: httpx.MockTransport) -> HttpBotApi:
    return HttpBotApi(BOT_TOKEN, transport=handler)


async def test_get_me_returns_the_public_identity_and_only_talks_to_telegram() -> None:
    seen: list[httpx.Request] = []

    def handle(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(
            200,
            json={
                "ok": True,
                "result": {"id": 5, "is_bot": True, "first_name": "Teleyes", "username": "tbot"},
            },
        )

    identity = await _bot_api(httpx.MockTransport(handle)).get_me()

    assert (identity.username, identity.id) == ("tbot", 5)
    assert [r.url.host for r in seen] == ["api.telegram.org"]
    assert seen[0].url.path.endswith("/getMe")


async def test_get_me_with_a_human_account_instead_of_a_bot_is_rejected() -> None:
    def handle(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, json={"ok": True, "result": {"id": 5, "is_bot": False, "username": "person"}}
        )

    with pytest.raises(BotApiError) as raised:
        await _bot_api(httpx.MockTransport(handle)).get_me()
    assert raised.value.code is BotApiErrorCode.UNEXPECTED


@pytest.mark.parametrize(
    ("status", "expected"),
    [
        (401, BotApiErrorCode.TOKEN_INVALID),
        (404, BotApiErrorCode.TOKEN_INVALID),
        (409, BotApiErrorCode.CONFLICT),
        (500, BotApiErrorCode.UNEXPECTED),
    ],
)
async def test_http_failures_map_to_codes(status: int, expected: BotApiErrorCode) -> None:
    transport = httpx.MockTransport(lambda _r: httpx.Response(status, json={"ok": False}))

    with pytest.raises(BotApiError) as raised:
        await _bot_api(transport).get_me()
    assert raised.value.code is expected


async def test_a_network_failure_never_leaks_the_token_through_the_exception() -> None:
    def handle(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("cannot connect", request=request)

    with pytest.raises(BotApiError) as raised:
        await _bot_api(httpx.MockTransport(handle)).get_me()

    assert raised.value.code is BotApiErrorCode.NETWORK
    assert BOT_TOKEN not in repr(raised.value) and BOT_TOKEN not in str(raised.value)
    assert raised.value.__cause__ is None and raised.value.__suppress_context__


async def test_get_updates_reads_private_start_messages_and_advances_the_offset() -> None:
    bodies: list[dict[str, object]] = []

    def handle(request: httpx.Request) -> httpx.Response:
        bodies.append(json.loads(request.content))
        return httpx.Response(
            200,
            json={
                "ok": True,
                "result": [
                    {
                        "update_id": 10,
                        "message": {
                            "chat": {"id": 99, "type": "private"},
                            "from": {"first_name": "Gabriel"},
                            "text": "/start CODE123",
                        },
                    },
                    {
                        "update_id": 11,
                        "message": {"chat": {"id": -5, "type": "group"}, "text": "/start CODE123"},
                    },
                    {
                        "update_id": 12,
                        "message": {"chat": {"id": 99, "type": "private"}, "text": "oi"},
                    },
                    {"update_id": 13, "edited_message": {}},
                ],
            },
        )

    result = await _bot_api(httpx.MockTransport(handle)).get_start_messages(
        offset=7, timeout_seconds=99
    )

    assert bodies[0]["offset"] == 7
    assert bodies[0]["timeout"] == 10  # capped
    assert bodies[0]["allowed_updates"] == ["message"]
    assert result.next_offset == 14
    assert [(s.chat_id, s.sender_name, s.payload) for s in result.starts] == [
        ("99", "Gabriel", "CODE123")
    ]


async def test_start_with_the_bot_mention_and_no_payload_has_an_empty_payload() -> None:
    transport = httpx.MockTransport(
        lambda _r: httpx.Response(
            200,
            json={
                "ok": True,
                "result": [
                    {
                        "update_id": 1,
                        "message": {"chat": {"id": 3, "type": "private"}, "text": "/start@tbot"},
                    }
                ],
            },
        )
    )

    result = await _bot_api(transport).get_start_messages(None, 0)

    assert [s.payload for s in result.starts] == [""]


@pytest.mark.parametrize(
    "token",
    ["", "abc", "123:short", f"{BOT_TOKEN}/../x", f"{BOT_TOKEN}?a=b", "http://evil/" + BOT_TOKEN],
)
def test_a_malformed_token_never_reaches_a_url(token: str) -> None:
    assert not is_valid_token(token)
    with pytest.raises(BotApiError):
        HttpBotApi(token)


def test_the_http_client_logger_cannot_print_request_lines_with_the_token() -> None:
    logger = logging.getLogger("httpx")

    assert logger.level >= logging.WARNING
    record = logging.LogRecord(
        "httpx",
        logging.WARNING,
        __file__,
        1,
        'POST https://api.telegram.org/bot%s/getMe "200"',
        (BOT_TOKEN,),
        None,
    )
    for flt in logger.filters:
        if isinstance(flt, logging.Filter):
            flt.filter(record)
    assert BOT_TOKEN not in record.getMessage()


# --- EscalatingRateLimiter ------------------------------------------------------------------


def test_lockout_doubles_on_each_strike_and_success_resets() -> None:
    clock = FakeClock()
    limiter = EscalatingRateLimiter(
        max_failures=3,
        window_seconds=600,
        base_lockout_seconds=60,
        max_lockout_seconds=300,
        clock=clock,
    )

    for _ in range(3):
        limiter.record_failure("k")
    assert limiter.is_locked("k") and 59 <= limiter.retry_after("k") <= 61

    clock.advance(61)
    assert not limiter.is_locked("k")
    for _ in range(3):
        limiter.record_failure("k")
    assert 119 <= limiter.retry_after("k") <= 121  # doubled

    clock.advance(121)
    for _ in range(3):
        limiter.record_failure("k")
    clock.advance(241)
    for _ in range(3):
        limiter.record_failure("k")
    assert limiter.retry_after("k") <= 301  # capped

    limiter.record_success("k")
    assert not limiter.is_locked("k")
    for _ in range(3):
        limiter.record_failure("k")
    assert limiter.retry_after("k") <= 61  # strikes were forgotten


def test_failures_outside_the_window_do_not_add_up() -> None:
    clock = FakeClock()
    limiter = EscalatingRateLimiter(max_failures=3, window_seconds=100, clock=clock)

    for _ in range(2):
        limiter.record_failure("k")
    clock.advance(101)
    limiter.record_failure("k")

    assert not limiter.is_locked("k")
    assert not limiter.is_locked("other")
