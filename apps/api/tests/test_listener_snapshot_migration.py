"""S25-F4: `listener_control.applied_snapshot` is additive, nullable and reversible."""

from pathlib import Path

from tests.conftest import AlembicRunner

from models.db import get_engine

PREVIOUS_HEAD = "a7d4b2e91c35"
THIS_REVISION = "d4b7e1a93c52"


def test_migration_adds_and_drops_the_snapshot_column(
    db_path: Path, alembic_runner: AlembicRunner
) -> None:
    url = f"sqlite:///{db_path}"

    def columns() -> set[str]:
        with get_engine(url).connect() as connection:
            rows = connection.exec_driver_sql("PRAGMA table_info(listener_control)").fetchall()
        return {row[1] for row in rows}

    assert alembic_runner("upgrade", PREVIOUS_HEAD, database_url=url).returncode == 0
    assert "applied_snapshot" not in columns()
    with get_engine(url).begin() as connection:
        connection.exec_driver_sql(
            "INSERT INTO listener_control (id, state, updated_at) "
            "VALUES (1, 'idle', '2026-11-01 00:00:00')"
        )

    up = alembic_runner("upgrade", THIS_REVISION, database_url=url)
    assert up.returncode == 0, up.stderr
    assert "applied_snapshot" in columns()
    with get_engine(url).connect() as connection:
        row = connection.exec_driver_sql("SELECT applied_snapshot FROM listener_control").one()
    assert row[0] is None  # the existing row is untouched

    down = alembic_runner("downgrade", PREVIOUS_HEAD, database_url=url)
    assert down.returncode == 0, down.stderr
    assert "applied_snapshot" not in columns()
