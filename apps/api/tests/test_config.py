import pytest

from app.config import Settings


def test_blank_tg_api_id_is_treated_as_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    # Exactly what `.env.example` ships (`TG_API_ID=`, present but blank) and
    # what a first `cp .env.example .env` produces before it's filled in —
    # this used to crash the whole process with a pydantic int-parsing error
    # instead of the honest not_configured state tg_api_hash/bot_token
    # already report for the same situation.
    monkeypatch.setenv("TG_API_ID", "")
    monkeypatch.setenv("TG_API_HASH", "")
    monkeypatch.setenv("BOT_TOKEN", "")

    settings = Settings()

    assert settings.tg_api_id is None


def test_a_real_tg_api_id_still_parses_as_an_integer(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TG_API_ID", "123456")

    settings = Settings()

    assert settings.tg_api_id == 123456
