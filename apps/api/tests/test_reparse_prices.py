from datetime import UTC, datetime

from sqlalchemy.orm import Session

from app.reparse_prices import reparse_prices
from models import Match, Rule, Source

NOW = datetime(2026, 10, 8, 12, 0, tzinfo=UTC)
MARKDOWN_COUPON_TEXT = (
    "Placa Mãe ASRock B650M-H/M.2+\n\nR$786,60\nOu em até 12x de R$ 71,25\n"
    "🎟Cupom: **__R$ 10 OFF__**\n"
)


def _add_match(session: Session, *, text: str, price_cents: int | None, **fields: object) -> int:
    source = Source(name="Grupo", telegram_chat_id="-100")
    rule = Rule(name="AM5", include_terms="placa")
    session.add_all([source, rule])
    session.flush()
    match = Match(
        source_id=source.id,
        rule_id=rule.id,
        message_text=text,
        price_cents=price_cents,
        matched_at=NOW,
        **fields,
    )
    session.add(match)
    session.commit()
    return match.id


def test_dry_run_reports_wrong_price_without_writing(session: Session) -> None:
    match_id = _add_match(session, text=MARKDOWN_COUPON_TEXT, price_cents=1000)

    changes = reparse_prices(session, apply=False)

    assert [(c.match_id, c.before[0], c.after[0]) for c in changes] == [(match_id, 1000, 78660)]
    session.expire_all()
    assert session.get(Match, match_id).price_cents == 1000  # type: ignore[union-attr]


def test_apply_rewrites_the_stored_price(session: Session) -> None:
    match_id = _add_match(session, text=MARKDOWN_COUPON_TEXT, price_cents=1000)

    reparse_prices(session, apply=True)

    session.expire_all()
    assert session.get(Match, match_id).price_cents == 78660  # type: ignore[union-attr]


def test_manually_edited_price_is_never_touched(session: Session) -> None:
    match_id = _add_match(
        session,
        text=MARKDOWN_COUPON_TEXT,
        price_cents=70000,
        price_source="manual",
        original_price_cents=1000,
    )

    changes = reparse_prices(session, apply=True)

    assert changes == []
    session.expire_all()
    assert session.get(Match, match_id).price_cents == 70000  # type: ignore[union-attr]


def test_correct_price_is_left_alone(session: Session) -> None:
    _add_match(session, text="Placa por R$ 899,90 no pix", price_cents=89990)

    assert reparse_prices(session, apply=True) == []
