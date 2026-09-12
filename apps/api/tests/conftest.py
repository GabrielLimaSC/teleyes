import os
import subprocess
import sys
from collections.abc import Callable, Iterator
from pathlib import Path

import pytest
from sqlalchemy.orm import Session

from models.db import get_engine, get_sessionmaker

ALEMBIC_DIR = Path(__file__).resolve().parents[1]

AlembicRunner = Callable[..., subprocess.CompletedProcess[str]]


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
def alembic_runner() -> AlembicRunner:
    return _run_alembic


@pytest.fixture
def db_path(tmp_path: Path) -> Iterator[Path]:
    yield tmp_path / "teleyes_test.db"


@pytest.fixture
def session(db_path: Path) -> Iterator[Session]:
    url = f"sqlite:///{db_path}"
    _run_alembic("upgrade", "head", database_url=url)
    engine = get_engine(url)
    with get_sessionmaker(engine)() as session:
        yield session
