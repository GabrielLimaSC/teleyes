"""S14-04 (F4): `app.digest_settings` — the single row's read/write helpers
and the `"HH:MM"` parser, independent of the scheduler/pipeline.
"""

from datetime import time

import pytest
from sqlalchemy.orm import Session

from app.digest_settings import (
    DEFAULT_SEND_AT_LOCAL,
    DEFAULT_TOP_N,
    load_digest_settings,
    parse_send_at_local,
    save_digest_settings,
)
from models import DigestSettings


def test_load_without_a_row_returns_an_unpersisted_disabled_default(session: Session) -> None:
    settings = load_digest_settings(session)

    assert settings.enabled is False
    assert settings.send_at_local == DEFAULT_SEND_AT_LOCAL
    assert settings.top_n == DEFAULT_TOP_N
    assert settings.mute_individual is False
    assert session.query(DigestSettings).count() == 0  # never created as a read side effect


def test_save_creates_the_row_on_the_first_call(session: Session) -> None:
    saved = save_digest_settings(
        session, enabled=True, send_at_local="21:30", top_n=3, mute_individual=True
    )

    assert saved.id == 1
    assert session.query(DigestSettings).count() == 1
    reloaded = load_digest_settings(session)
    assert reloaded.enabled is True
    assert reloaded.send_at_local == "21:30"
    assert reloaded.top_n == 3
    assert reloaded.mute_individual is True


def test_save_updates_the_same_row_on_a_second_call(session: Session) -> None:
    save_digest_settings(
        session, enabled=True, send_at_local="09:00", top_n=5, mute_individual=True
    )
    save_digest_settings(
        session, enabled=False, send_at_local="18:15", top_n=10, mute_individual=False
    )

    assert session.query(DigestSettings).count() == 1
    reloaded = load_digest_settings(session)
    assert reloaded.enabled is False
    assert reloaded.send_at_local == "18:15"
    assert reloaded.top_n == 10
    assert reloaded.mute_individual is False


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("09:00", time(9, 0)),
        ("9:00", time(9, 0)),
        ("00:00", time(0, 0)),
        ("23:59", time(23, 59)),
    ],
)
def test_parse_send_at_local_accepts_well_formed_hhmm(value: str, expected: time) -> None:
    assert parse_send_at_local(value) == expected


@pytest.mark.parametrize(
    "value",
    ["", "9", "9h00", "09:00:00", "24:00", "09:60", "abc", "09-00", " 09:00"],
)
def test_parse_send_at_local_rejects_malformed_values(value: str) -> None:
    with pytest.raises(ValueError):
        parse_send_at_local(value)
