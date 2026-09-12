import subprocess
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path

import pytest
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from models import Delivery, Match, Recipient, Rule, Source
from models.db import get_engine

AlembicRunner = Callable[..., subprocess.CompletedProcess[str]]


def test_alembic_upgrade_head_creates_empty_database(
    db_path: Path, alembic_runner: AlembicRunner
) -> None:
    url = f"sqlite:///{db_path}"

    result = alembic_runner("upgrade", "head", database_url=url)

    assert result.returncode == 0, result.stderr
    assert db_path.exists()


def test_alembic_upgrade_head_is_idempotent(
    db_path: Path, alembic_runner: AlembicRunner
) -> None:
    url = f"sqlite:///{db_path}"

    first = alembic_runner("upgrade", "head", database_url=url)
    second = alembic_runner("upgrade", "head", database_url=url)

    assert first.returncode == 0, first.stderr
    assert second.returncode == 0, second.stderr


def test_alembic_downgrade_removes_tables(
    db_path: Path, alembic_runner: AlembicRunner
) -> None:
    url = f"sqlite:///{db_path}"
    alembic_runner("upgrade", "head", database_url=url)

    result = alembic_runner("downgrade", "base", database_url=url)

    assert result.returncode == 0, result.stderr

    engine = get_engine(url)
    with engine.connect() as connection:
        tables = connection.exec_driver_sql(
            "SELECT name FROM sqlite_master WHERE type='table' AND name != 'alembic_version'"
        ).fetchall()
    assert tables == []


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
