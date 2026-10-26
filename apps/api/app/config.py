from functools import lru_cache
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_env: str = "development"
    tg_api_id: int | None = None
    tg_api_hash: str | None = None
    bot_token: str | None = None
    # S14-01: day boundaries of the price-history series ("menor preço do
    # dia") follow the timezone the dates are presented in; persistence
    # stays UTC. IANA name, validated on startup.
    display_timezone: str = "America/Sao_Paulo"
    # S19-03: demo mode (see app/demo_mode.py). Off by default and never set in
    # a real deployment. READONLY rejects every mutating request; LIVE makes the
    # api insert one fictional match every few seconds.
    # S19-01: the session cookie is Secure by default (HTTPS via Tailscale Serve or a
    # reverse proxy). A plain-http self-host on 127.0.0.1 sets this to false because
    # Safari drops Secure cookies on http even for localhost.
    session_cookie_secure: bool = True
    teleyes_demo: bool = False
    teleyes_demo_readonly: bool = False
    teleyes_demo_live: bool = False

    @field_validator("teleyes_demo", "teleyes_demo_readonly", "teleyes_demo_live", mode="before")
    @classmethod
    def _blank_flag_means_off(cls, value: object) -> object:
        if isinstance(value, str) and value.strip() == "":
            return False
        return value

    @field_validator("session_cookie_secure", mode="before")
    @classmethod
    def _blank_cookie_flag_means_secure(cls, value: object) -> object:
        if isinstance(value, str) and value.strip() == "":
            return True
        return value

    @field_validator("tg_api_id", mode="before")
    @classmethod
    def _blank_env_value_means_unset(cls, value: object) -> object:
        """`.env.example` ships `TG_API_ID=` — present but blank, exactly what
        a first-time `cp .env.example .env` produces before filling it in.
        `tg_api_hash`/`bot_token` (plain `str | None`) already treat that as
        falsy and correctly report `not_configured`; `tg_api_id: int | None`
        instead tried to parse "" as an integer and raised, crashing the
        whole `api` container on first boot — found while verifying the
        README's own onboarding steps actually work (S5-07).
        """
        if isinstance(value, str) and value.strip() == "":
            return None
        return value

    @field_validator("display_timezone")
    @classmethod
    def _known_timezone(cls, value: str) -> str:
        try:
            ZoneInfo(value)
        except (ZoneInfoNotFoundError, ValueError) as error:
            raise ValueError(f"unknown timezone: {value}") from error
        return value


@lru_cache
def get_settings() -> Settings:
    return Settings()
