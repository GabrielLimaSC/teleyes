import sqlite3
from datetime import UTC, datetime, timedelta
from pathlib import Path

from packages.backup.sqlite_backup import apply_retention, list_backups, run_backup_once


def _make_db(path: Path) -> None:
    connection = sqlite3.connect(str(path))
    connection.execute("CREATE TABLE match (id INTEGER PRIMARY KEY, message_text TEXT)")
    connection.execute("INSERT INTO match (message_text) VALUES ('promo real')")
    connection.commit()
    connection.close()


def test_backup_produces_a_restorable_standalone_database(tmp_path: Path) -> None:
    db_path = tmp_path / "teleyes.db"
    _make_db(db_path)
    backup_dir = tmp_path / "backups"

    backup_path = run_backup_once(db_path, backup_dir)

    assert backup_path.exists()
    restored = sqlite3.connect(str(backup_path))
    try:
        rows = restored.execute("SELECT message_text FROM match").fetchall()
    finally:
        restored.close()
    assert rows == [("promo real",)]


def test_backup_is_consistent_even_with_uncommitted_writes_pending_in_wal(tmp_path: Path) -> None:
    # The whole point of VACUUM INTO over a filesystem copy: a second,
    # concurrently open connection with a committed write not yet
    # checkpointed into the main file must still show up in the backup.
    db_path = tmp_path / "teleyes.db"
    _make_db(db_path)
    writer = sqlite3.connect(str(db_path))
    writer.execute("PRAGMA journal_mode=WAL")
    writer.execute(
        "INSERT INTO match (message_text) VALUES ('promo em WAL, não no arquivo principal')"
    )
    writer.commit()

    backup_path = run_backup_once(db_path, tmp_path / "backups")

    restored = sqlite3.connect(str(backup_path))
    try:
        count = restored.execute("SELECT COUNT(*) FROM match").fetchone()[0]
    finally:
        restored.close()
        writer.close()
    assert count == 2


def test_backup_filenames_sort_chronologically(tmp_path: Path) -> None:
    db_path = tmp_path / "teleyes.db"
    _make_db(db_path)
    backup_dir = tmp_path / "backups"
    base = datetime(2026, 1, 1, tzinfo=UTC)

    first = run_backup_once(db_path, backup_dir, now=base)
    second = run_backup_once(db_path, backup_dir, now=base + timedelta(hours=6))
    third = run_backup_once(db_path, backup_dir, now=base + timedelta(hours=12))

    assert list_backups(backup_dir) == sorted([first, second, third])


def test_retention_keeps_only_the_n_most_recent(tmp_path: Path) -> None:
    db_path = tmp_path / "teleyes.db"
    _make_db(db_path)
    backup_dir = tmp_path / "backups"
    base = datetime(2026, 1, 1, tzinfo=UTC)
    made = [
        run_backup_once(db_path, backup_dir, now=base + timedelta(hours=6 * i)) for i in range(5)
    ]

    deleted = apply_retention(backup_dir, keep=2)

    assert deleted == made[:3]
    assert list_backups(backup_dir) == made[3:]
    for path in made[3:]:
        assert path.exists()
    for path in deleted:
        assert not path.exists()


def test_retention_of_zero_deletes_everything(tmp_path: Path) -> None:
    db_path = tmp_path / "teleyes.db"
    _make_db(db_path)
    backup_dir = tmp_path / "backups"
    run_backup_once(db_path, backup_dir)

    deleted = apply_retention(backup_dir, keep=0)

    assert len(deleted) == 1
    assert list_backups(backup_dir) == []


def test_retention_below_current_count_is_a_no_op(tmp_path: Path) -> None:
    db_path = tmp_path / "teleyes.db"
    _make_db(db_path)
    backup_dir = tmp_path / "backups"
    only = run_backup_once(db_path, backup_dir)

    deleted = apply_retention(backup_dir, keep=10)

    assert deleted == []
    assert list_backups(backup_dir) == [only]
