"""S20-01: hard-delete matches the admin flagged as wrong (e.g. an advertiser's price typo).

Every price figure (lowest ever, 90-day minimum, averages, sparkline, target
gap) is computed on read from the `match` rows, so removing the rows is enough
for the wrong value to stop counting. Dependents (`delivery`, `match_correction`)
go with them. The message identity is recorded in `suppressed_message` so the
pipeline does not recreate the match from the same Telegram message.
"""

from collections.abc import Sequence

from sqlalchemy import and_, delete, or_, select
from sqlalchemy.orm import Session

from models import Delivery, Match, MatchCorrection, SuppressedMessage


def delete_matches(db: Session, matches: Sequence[Match]) -> list[int]:
    """Delete `matches` and everything hanging off them; returns the deleted ids.

    One Telegram message caught by several rules is several `Match` rows but one
    listing, so every row with the same message identity goes too (otherwise the
    wrong price would keep counting through the sibling). Caller commits.
    """
    if not matches:
        return []

    identities = {
        (match.source_id, match.telegram_message_id)
        for match in matches
        if match.telegram_message_id is not None
    }
    ids = {match.id for match in matches}
    if identities:
        ids.update(
            db.scalars(
                select(Match.id).where(
                    or_(
                        *(
                            and_(
                                Match.source_id == source_id,
                                Match.telegram_message_id == message_id,
                            )
                            for source_id, message_id in identities
                        )
                    )
                )
            )
        )
    match_ids = sorted(ids)

    already_suppressed = {
        (row.source_id, row.telegram_message_id)
        for row in db.scalars(
            select(SuppressedMessage).where(
                SuppressedMessage.source_id.in_({source_id for source_id, _ in identities})
            )
        )
    }
    for source_id, message_id in identities - already_suppressed:
        assert message_id is not None
        db.add(SuppressedMessage(source_id=source_id, telegram_message_id=message_id))

    db.execute(delete(Delivery).where(Delivery.match_id.in_(match_ids)))
    db.execute(delete(MatchCorrection).where(MatchCorrection.match_id.in_(match_ids)))
    db.execute(delete(Match).where(Match.id.in_(match_ids)))
    return match_ids
