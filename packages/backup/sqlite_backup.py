from __future__ import annotations

import sqlite3
from datetime import UTC, datetime
from pathlib import Path

FILENAME_PREFIX = "teleyes-"
FILENAME_SUFFIX = ".db"
_TIMESTAMP_FORMAT = "%Y%m%dT%H%M%SZ"


def backup_filename(now: datetime) -> str:
    return f"{FILENAME_PREFIX}{now.strftime(_TIMESTAMP_FORMAT)}{FILENAME_SUFFIX}"


def run_backup_once(db_path: Path, backup_dir: Path, *, now: datetime | None = None) -> Path:
    """Write one consistent, restorable snapshot of `db_path` into `backup_dir`.

    Uses `VACUUM INTO` (SQLite >= 3.27, present since well before the 3.53
    bundled with this project's Python) rather than a filesystem copy or a
    manual `PRAGMA wal_checkpoint` + copy: `VACUUM INTO` produces a
    transactionally consistent snapshot of the whole database in one atomic
    operation, safe against concurrent writers (`api`/`listener`, both
    writing to the same file since S5-09) without needing to pause them,
    checkpoint WAL by hand, or race a concurrent auto-checkpoint mid-copy.
    The output is itself a complete, standalone SQLite file — restoring is
    just using it as the database, no separate restore tool needed.
    """
    backup_dir.mkdir(parents=True, exist_ok=True)
    backup_path = backup_dir / backup_filename(now or datetime.now(UTC))

    connection = sqlite3.connect(str(db_path))
    try:
        connection.execute("VACUUM INTO ?", (str(backup_path),))
    finally:
        connection.close()

    return backup_path


def list_backups(backup_dir: Path) -> list[Path]:
    """Existing backups, oldest first — the filename's timestamp sorts
    lexicographically in chronological order, so no need to stat every file.
    """
    return sorted(backup_dir.glob(f"{FILENAME_PREFIX}*{FILENAME_SUFFIX}"))


def apply_retention(backup_dir: Path, *, keep: int) -> list[Path]:
    """Delete every backup except the `keep` most recent; return what was deleted."""
    backups = list_backups(backup_dir)
    to_delete = backups[:-keep] if keep > 0 else backups
    for path in to_delete:
        path.unlink()
    return to_delete
