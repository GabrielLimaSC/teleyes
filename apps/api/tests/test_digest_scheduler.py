"""S14-04 (F4): `DigestScheduler.tick` — the listener-process polling loop.
Uses a real file-backed sqlite (Alembic schema) through a `sessionmaker`,
since `DigestScheduler` opens/closes its own session per tick, same pattern
`ReloadWorker`'s own tests use.
"""

import subprocess
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path

import pytest
from sqlalchemy.orm import Session, sessionmaker

from app.digest import DigestScheduler
from app.digest_settings import save_digest_settings
from models import DigestRun
from models.db import get_engine, get_sessionmaker
from packages.notifications.bot import BotNotifier
from packages.notifications.fakes import FakeBotClient

AlembicRunner = Callable[..., subprocess.CompletedProcess[str]]


@pytest.fixture
def session_factory(db_path: Path, alembic_runner: AlembicRunner) -> sessionmaker[Session]:
    url = f"sqlite:///{db_path}"
    alembic_runner("upgrade", "head", database_url=url)
    return get_sessionmaker(get_engine(url))


def _configure(
    session_factory: sessionmaker[Session],
    *,
    enabled: bool,
    send_at_local: str,
    top_n: int = 5,
    mute_individual: bool = True,
) -> None:
    with session_factory() as session:
        save_digest_settings(
            session,
            enabled=enabled,
            send_at_local=send_at_local,
            top_n=top_n,
            mute_individual=mute_individual,
        )


async def test_tick_is_a_no_op_when_digest_is_disabled(
    session_factory: sessionmaker[Session],
) -> None:
    _configure(session_factory, enabled=False, send_at_local="09:00")
    scheduler = DigestScheduler(
        session_factory=session_factory,
        notifier=BotNotifier(bot_token="token", client=FakeBotClient(), allowlisted_chat_ids=set()),
        now=lambda: datetime(2026, 9, 24, 13, 0, tzinfo=UTC),  # well past 09:00 local
    )

    outcome = await scheduler.tick()

    assert outcome is None
    with session_factory() as session:
        assert session.query(DigestRun).count() == 0


async def test_tick_is_a_no_op_before_the_local_send_time(
    session_factory: sessionmaker[Session],
) -> None:
    _configure(session_factory, enabled=True, send_at_local="09:00")
    scheduler = DigestScheduler(
        session_factory=session_factory,
        notifier=BotNotifier(bot_token="token", client=FakeBotClient(), allowlisted_chat_ids=set()),
        now=lambda: datetime(2026, 9, 24, 10, 0, tzinfo=UTC),  # 07:00 in São Paulo
    )

    outcome = await scheduler.tick()

    assert outcome is None


async def test_tick_runs_once_the_local_clock_reaches_send_at_local(
    session_factory: sessionmaker[Session],
) -> None:
    _configure(session_factory, enabled=True, send_at_local="09:00")
    scheduler = DigestScheduler(
        session_factory=session_factory,
        notifier=BotNotifier(bot_token="token", client=FakeBotClient(), allowlisted_chat_ids=set()),
        now=lambda: datetime(2026, 9, 24, 13, 0, tzinfo=UTC),  # 10:00 in São Paulo
    )

    outcome = await scheduler.tick()

    assert outcome is not None
    assert outcome.ran is True
    with session_factory() as session:
        assert session.query(DigestRun).count() == 1


async def test_a_restart_the_same_local_day_never_resends(
    session_factory: sessionmaker[Session],
) -> None:
    """The done_when: reiniciar no mesmo dia não reenvia. Two independent
    `DigestScheduler` instances (simulating a process restart) each opening
    their own session must still only really run once.
    """
    _configure(session_factory, enabled=True, send_at_local="09:00")
    fixed_now = datetime(2026, 9, 24, 13, 0, tzinfo=UTC)

    first_process = DigestScheduler(
        session_factory=session_factory,
        notifier=BotNotifier(bot_token="token", client=FakeBotClient(), allowlisted_chat_ids=set()),
        now=lambda: fixed_now,
    )
    first_outcome = await first_process.tick()

    second_process = DigestScheduler(
        session_factory=session_factory,
        notifier=BotNotifier(bot_token="token", client=FakeBotClient(), allowlisted_chat_ids=set()),
        now=lambda: fixed_now,
    )
    second_outcome = await second_process.tick()

    assert first_outcome is not None and first_outcome.ran is True
    assert second_outcome is not None and second_outcome.ran is False
    with session_factory() as session:
        assert session.query(DigestRun).count() == 1


async def test_process_down_through_the_send_time_still_sends_once_on_the_next_tick(
    session_factory: sessionmaker[Session],
) -> None:
    """The done_when: processo parado no horário -> envia uma vez ao subir.
    The very first tick after the process comes back up, well past
    `send_at_local`, must still run today's digest exactly once.
    """
    _configure(session_factory, enabled=True, send_at_local="09:00")
    scheduler = DigestScheduler(
        session_factory=session_factory,
        notifier=BotNotifier(bot_token="token", client=FakeBotClient(), allowlisted_chat_ids=set()),
        now=lambda: datetime(2026, 9, 24, 20, 0, tzinfo=UTC),  # 17:00 local, hours late
    )

    outcome = await scheduler.tick()

    assert outcome is not None
    assert outcome.ran is True


async def test_an_invalid_send_at_local_is_treated_as_not_due_rather_than_crashing(
    session_factory: sessionmaker[Session],
) -> None:
    _configure(session_factory, enabled=True, send_at_local="not-a-time")
    scheduler = DigestScheduler(
        session_factory=session_factory,
        notifier=BotNotifier(bot_token="token", client=FakeBotClient(), allowlisted_chat_ids=set()),
        now=lambda: datetime(2026, 9, 24, 13, 0, tzinfo=UTC),
    )

    outcome = await scheduler.tick()

    assert outcome is None
