import os
import sqlite3
from pathlib import Path

from sqlalchemy import Engine, create_engine, event
from sqlalchemy.orm import Session, sessionmaker

# Anchored to the repo root (apps/api/models/db.py -> apps/api -> apps -> root) so the
# default resolves to the same file regardless of the process's current working
# directory — a bare relative path silently pointed at a different db.sqlite depending
# on whether you ran things from the repo root or from apps/api.
_DEFAULT_DB_PATH = Path(__file__).resolve().parents[3] / "data" / "teleyes.db"


def get_database_url() -> str:
    return os.getenv("DATABASE_URL", f"sqlite:///{_DEFAULT_DB_PATH}")


def get_engine(database_url: str | None = None) -> Engine:
    url = database_url or get_database_url()
    connect_args = {"check_same_thread": False} if url.startswith("sqlite") else {}
    engine = create_engine(url, connect_args=connect_args)
    if url.startswith("sqlite"):
        event.listens_for(engine, "connect")(_set_sqlite_pragmas)
    return engine


def _set_sqlite_pragmas(dbapi_connection: sqlite3.Connection, _connection_record: object) -> None:
    """WAL mode (CLAUDE.md's binding decision) was never actually turned on
    anywhere — SQLite silently defaults to the rollback-journal mode instead,
    which locks the *whole file* on every write. That went unnoticed as long
    as exactly one process ever wrote to teleyes.db; S5-09 makes `api` and
    `listener` two separate OS processes doing that at once for the first
    time, which is exactly when a missing WAL mode turns into real
    "database is locked" errors under concurrent writes. `busy_timeout` makes
    a write that's briefly blocked by another writer retry for a bit instead
    of failing immediately — WAL alone doesn't serialize writers, it only
    lets readers stop blocking on a writer. A no-op on `:memory:` databases
    (SQLite doesn't support WAL there), so existing in-memory test fixtures
    are unaffected.
    """
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.execute("PRAGMA busy_timeout=5000")
    cursor.close()


def get_sessionmaker(engine: Engine | None = None) -> sessionmaker[Session]:
    return sessionmaker(bind=engine or get_engine(), expire_on_commit=False)
