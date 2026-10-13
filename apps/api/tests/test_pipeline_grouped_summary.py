"""S14-05 (F5): the `match` SSE event's `grouped_summary` — a live event that
lands inside an already-existing duplicate group (same `product_key` +
price, `compute_group_key`'s own bucket) carries that group's
`seen_count`/`sources`, so the feed's live UI can update the existing card
instead of appending a duplicate one.
"""

from datetime import UTC, datetime, timedelta

from sqlalchemy.orm import Session

from app.feed_settings import set_group_duplicates
from app.pipeline import ProcessResult, build_match_event
from models import Match, Rule, Source

NOW = datetime(2026, 9, 24, 12, 0, tzinfo=UTC)
PRODUCT_KEY = "palit-rtx-5070-ti"


def _seed_sources_and_rule(session: Session) -> tuple[Source, Source, Rule]:
    source_a = Source(name="Grupo A", telegram_chat_id="-1001")
    source_b = Source(name="Grupo B", telegram_chat_id="-1002")
    rule = Rule(name="Placas", include_terms="rtx")
    session.add_all([source_a, source_b, rule])
    session.commit()
    return source_a, source_b, rule


def test_grouped_summary_carries_the_existing_groups_seen_count_and_sources(
    session: Session,
) -> None:
    source_a, source_b, rule = _seed_sources_and_rule(session)

    existing = Match(
        source_id=source_a.id,
        rule_id=rule.id,
        message_text="RTX 5070 Ti por R$ 4.000,00",
        price_cents=400_000,
        product_key=PRODUCT_KEY,
        matched_at=NOW,
        telegram_message_id=1,
    )
    session.add(existing)
    session.commit()

    new_match = Match(
        source_id=source_b.id,
        rule_id=rule.id,
        message_text="RTX 5070 Ti também por R$ 4.000,00",
        price_cents=400_000,
        product_key=PRODUCT_KEY,
        matched_at=NOW + timedelta(minutes=5),
        telegram_message_id=2,
    )
    session.add(new_match)
    session.commit()

    result = ProcessResult(match=new_match, deliveries_sent=1)
    event = build_match_event(result, session)

    assert event is not None
    assert event["group_key"] is not None
    assert event["grouped_summary"] == {
        "seen_count": 2,
        "sources": [
            {"id": source_a.id, "name": "Grupo A"},
            {"id": source_b.id, "name": "Grupo B"},
        ],
    }


def test_grouped_summary_is_none_when_nothing_to_fold_into(session: Session) -> None:
    source_a, _source_b, rule = _seed_sources_and_rule(session)

    match = Match(
        source_id=source_a.id,
        rule_id=rule.id,
        message_text="RTX 5070 Ti por R$ 4.000,00",
        price_cents=400_000,
        product_key=PRODUCT_KEY,
        matched_at=NOW,
        telegram_message_id=1,
    )
    session.add(match)
    session.commit()

    event = build_match_event(ProcessResult(match=match, deliveries_sent=1), session)

    assert event is not None
    assert event["group_key"] is not None
    assert event["grouped_summary"] is None


def test_grouped_summary_is_none_without_a_session(session: Session) -> None:
    source_a, _source_b, rule = _seed_sources_and_rule(session)
    match = Match(
        source_id=source_a.id,
        rule_id=rule.id,
        message_text="RTX 5070 Ti por R$ 4.000,00",
        price_cents=400_000,
        product_key=PRODUCT_KEY,
        matched_at=NOW,
        telegram_message_id=1,
    )
    session.add(match)
    session.commit()

    event = build_match_event(ProcessResult(match=match, deliveries_sent=1))

    assert event is not None
    assert event["grouped_summary"] is None


def test_grouped_summary_is_none_when_the_toggle_is_off(session: Session) -> None:
    source_a, source_b, rule = _seed_sources_and_rule(session)
    set_group_duplicates(session, False)

    existing = Match(
        source_id=source_a.id,
        rule_id=rule.id,
        message_text="RTX 5070 Ti por R$ 4.000,00",
        price_cents=400_000,
        product_key=PRODUCT_KEY,
        matched_at=NOW,
        telegram_message_id=1,
    )
    session.add(existing)
    session.commit()

    new_match = Match(
        source_id=source_b.id,
        rule_id=rule.id,
        message_text="RTX 5070 Ti também por R$ 4.000,00",
        price_cents=400_000,
        product_key=PRODUCT_KEY,
        matched_at=NOW + timedelta(minutes=5),
        telegram_message_id=2,
    )
    session.add(new_match)
    session.commit()

    event = build_match_event(ProcessResult(match=new_match, deliveries_sent=1), session)

    assert event is not None
    assert event["grouped_summary"] is None
