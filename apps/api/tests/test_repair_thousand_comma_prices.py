import sys
from datetime import UTC, datetime
from pathlib import Path

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from models import Match, Rule, Source

# scripts/ isn't a package: same sys.path convention as test_seed_rules.py.
sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "scripts"))
import repair_thousand_comma_prices as repair  # type: ignore[import-not-found]  # noqa: E402

SECRET = "SEGREDO-MENSAGEM"


def _add(
    session: Session,
    text: str,
    price: int | None,
    *,
    source: Source,
    rule: Rule,
    n: int,
    **extra: object,
) -> int:
    match = Match(
        source_id=source.id,
        rule_id=rule.id,
        telegram_message_id=n,
        message_text=text,
        price_cents=price,
        message_link=f"https://t.me/{SECRET}/{n}",
        matched_at=datetime.now(UTC),
        **extra,
    )
    session.add(match)
    session.flush()
    return match.id


@pytest.fixture
def seeded(session: Session) -> dict[str, int]:
    source = Source(name="Grupo", telegram_chat_id="-100")
    rule = Rule(name="Regra", include_terms="rtx")
    session.add_all([source, rule])
    session.flush()
    ids = {
        "a": _add(session, f"RTX 5070 por 6,991 {SECRET}", 699, source=source, rule=rule, n=1),
        "b": _add(session, "Kit RAM 1,007 hoje", 100, source=source, rule=rule, n=2),
        "c": _add(session, "Placa 7,070 pix", 707, source=source, rule=rule, n=3),
        "ok": _add(session, "SSD R$ 299,90", 29990, source=source, rule=rule, n=4),
        "manual": _add(
            session,
            "Placa 7,070 pix",
            123,
            source=source,
            rule=rule,
            n=5,
            price_source="manual",
            original_price_cents=707,
        ),
        "other": _add(session, "Fonte R$ 400,00", 12345, source=source, rule=rule, n=6),
        "parsed": _add(
            session,
            "Placa 6,991 hoje",
            699,
            source=source,
            rule=rule,
            n=7,
            price_source="parsed",
            original_price_cents=699,
        ),
        "none": _add(session, "sem preço aqui", None, source=source, rule=rule, n=8),
    }
    session.commit()
    return ids


def _prices(session: Session) -> dict[int, int | None]:
    session.expire_all()
    return {m.id: m.price_cents for m in session.scalars(select(Match))}


def test_dry_run_does_not_write(session: Session, seeded: dict[str, int]) -> None:
    before = _prices(session)
    report = repair.repair_prices(session, apply=False)

    assert _prices(session) == before
    assert set(report.affected_ids) == {seeded[k] for k in ("a", "b", "c", "parsed")}
    assert report.applied == 0


def test_apply_fixes_only_proven_records(session: Session, seeded: dict[str, int]) -> None:
    report = repair.repair_prices(session, apply=True)

    prices = _prices(session)
    assert prices[seeded["a"]] == 699_100
    assert prices[seeded["b"]] == 100_700
    assert prices[seeded["c"]] == 707_000
    assert prices[seeded["parsed"]] == 699_100
    assert prices[seeded["ok"]] == 29990
    assert prices[seeded["manual"]] == 123
    assert prices[seeded["other"]] == 12345
    assert prices[seeded["none"]] is None
    assert report.review_ids == [seeded["other"]]
    assert report.manual_skipped == 1
    parsed = session.get(Match, seeded["parsed"])
    manual = session.get(Match, seeded["manual"])
    assert parsed is not None and manual is not None
    assert parsed.original_price_cents == 699_100
    assert manual.original_price_cents == 707


def test_second_run_changes_nothing(session: Session, seeded: dict[str, int]) -> None:
    repair.repair_prices(session, apply=True)
    after_first = _prices(session)

    report = repair.repair_prices(session, apply=True)

    assert _prices(session) == after_first
    assert report.applied == 0
    assert report.affected_ids == []


def test_apply_without_confirm_backup_refuses(
    capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    def boom() -> None:
        raise AssertionError("must not open the database")

    monkeypatch.setattr(repair, "get_engine", boom)

    assert repair.main(["--apply"]) == 2
    assert "--confirm-backup" in capsys.readouterr().err


def test_output_never_contains_message_text_or_link(
    session: Session, seeded: dict[str, int], capsys: pytest.CaptureFixture[str]
) -> None:
    report = repair.repair_prices(session, apply=False)
    repair.print_report(report, apply=False)

    out = capsys.readouterr().out
    assert SECRET not in out
    assert "t.me" not in out
    assert "R$ 6.991,00" in out
    assert "R$ 6,99" in out
