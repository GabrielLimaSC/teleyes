"""S23-01: no endpoint ever hands a secret back.

Plants recognisable secrets both ways the app can hold them (environment and the setup
wizard's secret store), then reads every GET endpoint and checks that none of them
shows up in any body or header.
"""

import re
from collections.abc import Iterator
from pathlib import Path

import pytest
from tests.match_api_support import ApiContext, api  # noqa: F401  (fixture)

from app.config import get_settings
from app.main import app
from packages.setup.secret_store import SecretStore

ENV_TOKEN = "987654321:AAEnvTokenEnvTokenEnvTokenEnvTokenEnv"
ENV_HASH = "feedfacefeedfacefeedfacefeedface"
STORE_TOKEN = "555555555:AAStoreTokenStoreTokenStoreTokenStore1"
STORE_HASH = "cafebabecafebabecafebabecafebabe"
SECRETS = [ENV_TOKEN, ENV_HASH, STORE_TOKEN, STORE_HASH, "AAEnvToken", "AAStoreToken"]


@pytest.fixture
def planted(
    api: ApiContext,  # noqa: F811
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> Iterator[ApiContext]:
    monkeypatch.setenv("BOT_TOKEN", ENV_TOKEN)
    monkeypatch.setenv("TG_API_HASH", ENV_HASH)
    monkeypatch.setenv("TG_API_ID", "111")
    get_settings.cache_clear()
    store = SecretStore(tmp_path / "secrets.json")
    store.update({"tg_api_hash": STORE_HASH, "bot_token": STORE_TOKEN, "tg_api_id": 222})
    monkeypatch.setattr(app.state, "secret_store", store)
    try:
        yield api
    finally:
        get_settings.cache_clear()


def _get_paths() -> list[str]:
    paths = app.openapi()["paths"]
    return [
        re.sub(r"\{[^}]+\}", "1", path)
        for path, operations in paths.items()
        if "get" in operations and path not in {"/events"}  # /events is an endless SSE stream
    ]


@pytest.mark.parametrize("path", _get_paths())
def test_no_get_endpoint_returns_a_secret(planted: ApiContext, path: str) -> None:
    response = planted.client.get(path)

    haystack = response.text + str(dict(response.headers))
    for secret in SECRETS:
        assert secret not in haystack, f"GET {path} leaked a secret"


def test_the_planted_secrets_are_really_in_use(planted: ApiContext) -> None:
    """Guards the test above: the wizard must see the secrets it is supposed to hide."""
    status = planted.client.get("/setup/status")

    assert status.status_code == 200
    body = status.json()
    assert body["credentials"]["configured"] is True
    assert body["bot"]["configured"] is True
