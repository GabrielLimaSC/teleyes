"""Re-run `extract_price` over stored matches after the extractor improves.

Every match keeps the original `message_text`, so a parsing bug fixed today
(e.g. the markdown-wrapped coupon taken as the price) can be corrected in the
history too, instead of leaving those rows wrong forever. Manually edited
prices (`price_source == "manual"`) are never touched: Gabriel's correction
always wins over the parser. No alert is sent and no metric is counted — this
only rewrites the stored price fields, exactly as the live pipeline would have
written them.
"""

from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session

from models.match import Match
from packages.rules.price import extract_price


@dataclass(frozen=True)
class PriceChange:
    match_id: int
    before: tuple[int | None, int | None, int | None]
    after: tuple[int | None, int | None, int | None]


def _stored_prices(match: Match) -> tuple[int | None, int | None, int | None]:
    return match.price_cents, match.price_cash_cents, match.price_card_cents


def reparse_prices(session: Session, *, apply: bool) -> list[PriceChange]:
    """Return every match whose price would change; write them when `apply`."""
    changes: list[PriceChange] = []
    query = select(Match).where((Match.price_source.is_(None)) | (Match.price_source != "manual"))
    for match in session.scalars(query):
        extraction = extract_price(match.message_text)
        after = (
            extraction.price_cents,
            extraction.price_cash_cents,
            extraction.price_card_cents,
        )
        before = _stored_prices(match)
        if after == before:
            continue
        changes.append(PriceChange(match_id=match.id, before=before, after=after))
        if apply:
            match.price_cents, match.price_cash_cents, match.price_card_cents = after
    if apply:
        session.commit()
    return changes
