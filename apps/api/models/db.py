import os
from pathlib import Path

from sqlalchemy import Engine, create_engine
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
    return create_engine(url, connect_args=connect_args)


def get_sessionmaker(engine: Engine | None = None) -> sessionmaker[Session]:
    return sessionmaker(bind=engine or get_engine(), expire_on_commit=False)
