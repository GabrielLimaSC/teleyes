import os
import subprocess
import sys
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path

import pytest
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from models import Delivery, Match, Recipient, Rule, Source
from models.db import get_engine, get_sessionmaker

ALEMBIC_DIR = Path(__file__).resolve().parents[1]


def _run_alembic(*args: str, database_url: str) -> subprocess.CompletedProcess[str]:
    env = {**os.environ, "DATABASE_URL": database_url}
    return subprocess.run(
        [sys.executable, "-m", "alembic", *args],
        cwd=ALEMBIC_DIR,
        env=env,
        capture_output=True,
        text=True,
    )


@pytest.fixture
def db_path(tmp_path: Path) -> Iterator[Path]:
    yield tmp_path / "teleyes_test.db"


def test_alembic_upgrade_head_creates_empty_database(db_path: Path) -> None:
    url = f"sqlite:///{db_path}"

    result = _run_alembic("upgrade", "head", database_url=url)

    assert result.returncode == 0, result.stderr
    assert db_path.exists()


def test_alembic_upgrade_head_is_idempotent(db_path: Path) -> None:
    url = f"sqlite:///{db_path}"

    first = _run_alembic("upgrade", "head", database_url=url)
    second = _run_alembic("upgrade", "head", database_url=url)

    assert first.returncode == 0, first.stderr
    assert second.returncode == 0, second.stderr


def test_alembic_downgrade_removes_tables(db_path: Path) -> None:
    url = f"sqlite:///{db_path}"
    _run_alembic("upgrade", "head", database_url=url)

    result = _run_alembic("downgrade", "base", database_url=url)

    assert result.returncode == 0, result.stderr

    engine = get_engine(url)
    with engine.connect() as connection:
        tables = connection.exec_driver_sql(
            "SELECT name FROM sqlite_master WHERE type='table' AND name != 'alembic_version'"
        ).fetchall()
    assert tables == []


@pytest.fixture
def session(db_path: Path) -> Iterator[Session]:
    url = f"sqlite:///{db_path}"
    _run_alembic("upgrade", "head", database_url=url)
    engine = get_engine(url)
    with get_sessionmaker(engine)() as session:
        yield session


def test_delivery_unique_constraint_blocks_duplicate(session: Session) -> None:
    source = Source(name="Grupo Teste", telegram_chat_id="-100123")
    rule = Rule(name="Regra Teste", include_terms="promo")
    recipient = Recipient(name="Gabriel", telegram_chat_id="999", allowlisted=True)
    session.add_all([source, rule, recipient])
    session.flush()

    match = Match(
        source_id=source.id,
        rule_id=rule.id,
        message_text="Promo teste",
        matched_at=datetime.now(UTC),
    )
    session.add(match)
    session.flush()

    session.add(Delivery(match_id=match.id, recipient_id=recipient.id))
    session.commit()

    session.add(Delivery(match_id=match.id, recipient_id=recipient.id))
    with pytest.raises(IntegrityError):
        session.commit()
