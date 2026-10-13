import sqlite3
import subprocess
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path

import pytest
from sqlalchemy import func, inspect, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from models import Delivery, Match, Recipient, Rule, Snooze, Source
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


def test_file_based_sqlite_connections_use_wal_mode(db_path: Path) -> None:
    # Two OS processes (api + listener, S5-09) now write to the same file —
    # the default rollback-journal mode locks the whole database on every
    # write, which is fine for one writer but starts throwing "database is
    # locked" the moment a second one shows up. This was never turned on
    # anywhere despite being a binding decision in CLAUDE.md.
    engine = get_engine(f"sqlite:///{db_path}")
    with engine.connect() as connection:
        mode = connection.exec_driver_sql("PRAGMA journal_mode").scalar()
    assert mode == "wal"


def test_in_memory_sqlite_does_not_error_on_wal_pragma() -> None:
    # SQLite itself refuses WAL on :memory: databases and silently keeps its
    # own default instead — existing test fixtures use :memory:, so this pragma
    # must not raise or otherwise break them.
    engine = get_engine("sqlite:///:memory:")
    with engine.connect() as connection:
        connection.exec_driver_sql("SELECT 1")


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


def test_delivery_unique_constraint_allows_a_target_row_alongside_an_immediate_one(
    session: Session,
) -> None:
    """S14-02: the constraint grew a `kind` column precisely so a match that
    is both grouped (S7-11) and a target hit can have a suppressed
    `"immediate"` bookkeeping row and a real `"target"` send at once —
    without this, the second insert below would hit the same
    `IntegrityError` as the test above.
    """
    source = Source(name="Grupo Teste", telegram_chat_id="-100123")
    rule = Rule(name="Regra Teste", include_terms="promo", target_price_cents=1000)
    recipient = Recipient(name="Gabriel", telegram_chat_id="999", allowlisted=True)
    session.add_all([source, rule, recipient])
    session.flush()

    match = Match(
        source_id=source.id,
        rule_id=rule.id,
        message_text="Promo teste",
        price_cents=999,
        matched_at=datetime.now(UTC),
    )
    session.add(match)
    session.flush()

    session.add(
        Delivery(
            match_id=match.id, recipient_id=recipient.id, kind="immediate", status="grouped"
        )
    )
    session.add(
        Delivery(match_id=match.id, recipient_id=recipient.id, kind="target", status="sent")
    )
    session.commit()

    assert session.scalar(select(func.count()).select_from(Delivery)) == 2

    # A second row of the *same* kind for the same match+recipient still
    # collides — the constraint only grew wider, it was never dropped.
    session.add(
        Delivery(match_id=match.id, recipient_id=recipient.id, kind="target", status="sent")
    )
    with pytest.raises(IntegrityError):
        session.commit()


def test_match_identity_migration_preserves_legacy_data_and_downgrades(
    db_path: Path, alembic_runner: AlembicRunner
) -> None:
    url = f"sqlite:///{db_path}"
    previous_head = "6431f12a4852"
    before = alembic_runner("upgrade", previous_head, database_url=url)
    assert before.returncode == 0, before.stderr

    timestamp = "2026-09-13 12:00:00"
    with sqlite3.connect(db_path) as connection:
        connection.execute(
            "INSERT INTO source (id, name, telegram_chat_id, created_at, active) "
            "VALUES (1, 'Legacy source', '-1001', ?, 1)",
            (timestamp,),
        )
        connection.execute(
            "INSERT INTO rule (id, name, include_terms, active, created_at) "
            "VALUES (1, 'Legacy rule', 'promo', 1, ?)",
            (timestamp,),
        )
        connection.execute(
            "INSERT INTO match "
            "(id, source_id, rule_id, message_text, matched_at, created_at) "
            "VALUES (1, 1, 1, 'legacy promo', ?, ?)",
            (timestamp, timestamp),
        )

    upgrade = alembic_runner("upgrade", "head", database_url=url)
    assert upgrade.returncode == 0, upgrade.stderr

    constraints = {
        constraint["name"]: constraint["column_names"]
        for constraint in inspect(get_engine(url)).get_unique_constraints("match")
    }
    assert constraints["uq_match_source_rule_telegram_message"] == [
        "source_id",
        "rule_id",
        "telegram_message_id",
    ]

    with sqlite3.connect(db_path) as connection:
        legacy = connection.execute(
            "SELECT message_text, telegram_message_id FROM match WHERE id = 1"
        ).fetchone()
        assert legacy == ("legacy promo", None)

        connection.execute(
            "INSERT INTO match "
            "(id, source_id, rule_id, telegram_message_id, message_text, matched_at, created_at) "
            "VALUES (2, 1, 1, 99, 'identified promo', ?, ?)",
            (timestamp, timestamp),
        )
        connection.commit()
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                "INSERT INTO match "
                "(id, source_id, rule_id, telegram_message_id, message_text, matched_at, "
                "created_at) VALUES (3, 1, 1, 99, 'duplicate identity', ?, ?)",
                (timestamp, timestamp),
            )
        connection.rollback()
        # NULL remains intentionally repeatable for rows without Telegram identity.
        connection.execute(
            "INSERT INTO match "
            "(id, source_id, rule_id, message_text, matched_at, created_at) "
            "VALUES (4, 1, 1, 'another legacy promo', ?, ?)",
            (timestamp, timestamp),
        )

    downgrade = alembic_runner("downgrade", previous_head, database_url=url)
    assert downgrade.returncode == 0, downgrade.stderr

    with sqlite3.connect(db_path) as connection:
        columns = {row[1] for row in connection.execute("PRAGMA table_info('match')")}
        rows = connection.execute("SELECT id, message_text FROM match ORDER BY id").fetchall()
    assert "telegram_message_id" not in columns
    assert rows == [
        (1, "legacy promo"),
        (2, "identified promo"),
        (4, "another legacy promo"),
    ]


def test_cash_card_price_migration_preserves_legacy_rows_and_downgrades(
    db_path: Path, alembic_runner: AlembicRunner
) -> None:
    url = f"sqlite:///{db_path}"
    previous_head = "b1c4e6f8a201"
    before = alembic_runner("upgrade", previous_head, database_url=url)
    assert before.returncode == 0, before.stderr

    timestamp = "2026-09-14 12:00:00"
    with sqlite3.connect(db_path) as connection:
        connection.execute(
            "INSERT INTO source (id, name, telegram_chat_id, created_at, active) "
            "VALUES (1, 'Legacy source', '-1001', ?, 1)",
            (timestamp,),
        )
        connection.execute(
            "INSERT INTO rule (id, name, include_terms, active, created_at) "
            "VALUES (1, 'Legacy rule', 'promo', 1, ?)",
            (timestamp,),
        )
        connection.execute(
            "INSERT INTO match "
            "(id, source_id, rule_id, message_text, price_cents, matched_at, created_at) "
            "VALUES (1, 1, 1, 'legacy single-price promo', 19900, ?, ?)",
            (timestamp, timestamp),
        )

    upgrade = alembic_runner("upgrade", "head", database_url=url)
    assert upgrade.returncode == 0, upgrade.stderr

    with sqlite3.connect(db_path) as connection:
        columns = {row[1] for row in connection.execute("PRAGMA table_info('match')")}
        assert {"price_cash_cents", "price_card_cents"} <= columns

        legacy = connection.execute(
            "SELECT price_cents, price_cash_cents, price_card_cents FROM match WHERE id = 1"
        ).fetchone()
        assert legacy == (19900, None, None)

        connection.execute(
            "INSERT INTO match "
            "(id, source_id, rule_id, message_text, price_cents, price_cash_cents, "
            "price_card_cents, matched_at, created_at) "
            "VALUES (2, 1, 1, 'pix ou cartao promo', 38990, 38990, 41990, ?, ?)",
            (timestamp, timestamp),
        )
        connection.commit()

    downgrade = alembic_runner("downgrade", previous_head, database_url=url)
    assert downgrade.returncode == 0, downgrade.stderr

    with sqlite3.connect(db_path) as connection:
        columns = {row[1] for row in connection.execute("PRAGMA table_info('match')")}
        rows = connection.execute(
            "SELECT id, price_cents FROM match ORDER BY id"
        ).fetchall()
    assert "price_cash_cents" not in columns
    assert "price_card_cents" not in columns
    # price_cents itself (and the rest of the row) survives the downgrade untouched.
    assert rows == [(1, 19900), (2, 38990)]


def test_product_key_migration_backfills_existing_matches_and_downgrades(
    db_path: Path, alembic_runner: AlembicRunner
) -> None:
    url = f"sqlite:///{db_path}"
    previous_head = "34f9903299d5"
    before = alembic_runner("upgrade", previous_head, database_url=url)
    assert before.returncode == 0, before.stderr

    timestamp = "2026-09-20 12:00:00"
    palit = "Placa de Vídeo Palit RTX 5070 Ti 16GB\n\nR$ 5.749,00 no pix\nhttps://x.example/1"
    with sqlite3.connect(db_path) as connection:
        connection.execute(
            "INSERT INTO source (id, name, telegram_chat_id, created_at, active) "
            "VALUES (1, 'Legacy source', '-1001', ?, 1)",
            (timestamp,),
        )
        connection.execute(
            "INSERT INTO rule (id, name, include_terms, active, created_at) "
            "VALUES (1, 'Legacy rule', 'rtx', 1, ?)",
            (timestamp,),
        )
        connection.executemany(
            "INSERT INTO match (id, source_id, rule_id, message_text, matched_at, created_at) "
            "VALUES (?, 1, 1, ?, ?, ?)",
            [
                (1, palit, timestamp, timestamp),
                (2, "🔥 PLACA DE VIDEO PALIT RTX 5070 TI 16GB\nR$ 5.499", timestamp, timestamp),
                (3, "R$ 99,90 no pix", timestamp, timestamp),
            ],
        )

    upgrade = alembic_runner("upgrade", "head", database_url=url)
    assert upgrade.returncode == 0, upgrade.stderr

    indexes = {index["name"] for index in inspect(get_engine(url)).get_indexes("match")}
    assert "ix_match_product_key" in indexes
    with sqlite3.connect(db_path) as connection:
        rows = connection.execute(
            "SELECT id, product_key, message_text FROM match ORDER BY id"
        ).fetchall()
    assert [(row[0], row[1]) for row in rows] == [
        (1, "palit-rtx-5070-ti"),  # S14-01 recalibration: model fingerprint
        (2, "palit-rtx-5070-ti"),
        (3, None),
    ]
    assert rows[0][2] == palit

    downgrade = alembic_runner("downgrade", previous_head, database_url=url)
    assert downgrade.returncode == 0, downgrade.stderr
    with sqlite3.connect(db_path) as connection:
        columns = {row[1] for row in connection.execute("PRAGMA table_info('match')")}
        count = connection.execute("SELECT COUNT(*) FROM match").fetchone()
    assert "product_key" not in columns
    assert count == (3,)


def test_snooze_check_constraint_rejects_a_mismatched_scope_and_target(
    session: Session,
) -> None:
    rule = Rule(name="Regra Teste", include_terms="promo")
    session.add(rule)
    session.flush()

    now = datetime.now(UTC)

    session.add(Snooze(scope="rule", rule_id=rule.id, until=now))
    session.commit()

    session.add(Snooze(scope="product", product_key="algum-produto", until=now))
    session.commit()

    session.add(Snooze(scope="rule", rule_id=rule.id, product_key="algum-produto", until=now))
    with pytest.raises(IntegrityError):
        session.commit()
    session.rollback()

    session.add(Snooze(scope="product", rule_id=rule.id, until=now))
    with pytest.raises(IntegrityError):
        session.commit()
    session.rollback()

    session.add(Snooze(scope="rule", until=now))
    with pytest.raises(IntegrityError):
        session.commit()
    session.rollback()


def test_target_price_and_delivery_kind_migration_defaults_and_downgrades(
    db_path: Path, alembic_runner: AlembicRunner
) -> None:
    url = f"sqlite:///{db_path}"
    # S14-02's migration chains after S14-03's snooze migration (both were
    # written in parallel off the same S14-01 head, `7e2a9c4d1b35`) so the
    # two land as a single head instead of needing a merge migration.
    previous_head = "43125d69024e"
    before = alembic_runner("upgrade", previous_head, database_url=url)
    assert before.returncode == 0, before.stderr

    timestamp = "2026-09-23 12:00:00"
    with sqlite3.connect(db_path) as connection:
        connection.execute(
            "INSERT INTO source (id, name, telegram_chat_id, created_at, active) "
            "VALUES (1, 'Legacy source', '-1001', ?, 1)",
            (timestamp,),
        )
        connection.execute(
            "INSERT INTO rule (id, name, include_terms, active, created_at) "
            "VALUES (1, 'Legacy rule', 'promo', 1, ?)",
            (timestamp,),
        )
        connection.execute(
            "INSERT INTO match (id, source_id, rule_id, message_text, matched_at, created_at) "
            "VALUES (1, 1, 1, 'legacy promo', ?, ?)",
            (timestamp, timestamp),
        )
        connection.execute(
            "INSERT INTO recipient (id, name, telegram_chat_id, allowlisted, active, created_at) "
            "VALUES (1, 'Gabriel', '999', 1, 1, ?)",
            (timestamp,),
        )
        # A legacy delivery row, inserted the way every row looked before
        # `kind` existed — no value supplied for it at all.
        connection.execute(
            "INSERT INTO delivery (id, match_id, recipient_id, status, created_at) "
            "VALUES (1, 1, 1, 'sent', ?)",
            (timestamp,),
        )

    upgrade = alembic_runner("upgrade", "head", database_url=url)
    assert upgrade.returncode == 0, upgrade.stderr

    with sqlite3.connect(db_path) as connection:
        rule_columns = {row[1] for row in connection.execute("PRAGMA table_info('rule')")}
        legacy_kind = connection.execute(
            "SELECT kind FROM delivery WHERE id = 1"
        ).fetchone()
    assert "target_price_cents" in rule_columns
    # The pre-existing row backfills to "immediate" via the column's
    # `server_default` — it always meant a plain alert, never a target one.
    assert legacy_kind == ("immediate",)

    constraints = {
        constraint["name"]: sorted(constraint["column_names"])
        for constraint in inspect(get_engine(url)).get_unique_constraints("delivery")
    }
    assert constraints["uq_delivery_match_recipient_kind"] == [
        "kind",
        "match_id",
        "recipient_id",
    ]

    with sqlite3.connect(db_path) as connection:
        connection.execute(
            "UPDATE rule SET target_price_cents = 100000 WHERE id = 1"
        )
        # A target row can coexist with the pre-existing immediate one for
        # the same match+recipient (the whole point of widening the
        # constraint) — this insert must succeed.
        connection.execute(
            "INSERT INTO delivery (id, match_id, recipient_id, kind, status, created_at) "
            "VALUES (2, 1, 1, 'target', 'sent', ?)",
            (timestamp,),
        )
        connection.commit()

    downgrade = alembic_runner("downgrade", previous_head, database_url=url)
    assert downgrade.returncode == 0, downgrade.stderr

    with sqlite3.connect(db_path) as connection:
        rule_columns = {row[1] for row in connection.execute("PRAGMA table_info('rule')")}
        delivery_columns = {row[1] for row in connection.execute("PRAGMA table_info('delivery')")}
        # The downgrade collapses the immediate/target pair back to one row
        # (the earliest id) rather than leaving a now-illegal duplicate.
        remaining = connection.execute(
            "SELECT id FROM delivery ORDER BY id"
        ).fetchall()
    assert "target_price_cents" not in rule_columns
    assert "kind" not in delivery_columns
    assert remaining == [(1,)]
