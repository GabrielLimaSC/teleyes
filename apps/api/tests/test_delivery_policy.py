"""S14-03 (F3): `app.delivery_policy.is_snoozed`, the pipeline's only gate
before creating or enqueueing a `Delivery`. Every case uses an injected
clock (`now`), never `datetime.now()`.
"""

from datetime import UTC, datetime, timedelta

from sqlalchemy.orm import Session

from app.delivery_policy import is_snoozed
from models import Rule, Snooze

NOW = datetime(2026, 9, 23, 12, 0, tzinfo=UTC)


def _rule(session: Session, name: str = "iPhone") -> Rule:
    rule = Rule(name=name, include_terms="iphone")
    session.add(rule)
    session.flush()
    return rule


def test_not_snoozed_without_any_row(session: Session) -> None:
    rule = _rule(session)

    assert is_snoozed(session, rule_id=rule.id, product_key=None, now=NOW) is False


def test_active_rule_snooze_blocks(session: Session) -> None:
    rule = _rule(session)
    session.add(Snooze(scope="rule", rule_id=rule.id, until=NOW + timedelta(days=1)))
    session.flush()

    assert is_snoozed(session, rule_id=rule.id, product_key=None, now=NOW) is True


def test_active_product_snooze_blocks(session: Session) -> None:
    rule = _rule(session)
    session.add(
        Snooze(scope="product", product_key="palit-rtx-5070-ti", until=NOW + timedelta(days=1))
    )
    session.flush()

    assert is_snoozed(session, rule_id=rule.id, product_key="palit-rtx-5070-ti", now=NOW) is True


def test_expired_snooze_is_ignored(session: Session) -> None:
    rule = _rule(session)
    session.add(Snooze(scope="rule", rule_id=rule.id, until=NOW - timedelta(minutes=1)))
    session.flush()

    assert is_snoozed(session, rule_id=rule.id, product_key=None, now=NOW) is False


def test_snooze_of_another_rule_does_not_affect(session: Session) -> None:
    rule = _rule(session)
    other_rule = _rule(session, name="Notebook")
    session.add(Snooze(scope="rule", rule_id=other_rule.id, until=NOW + timedelta(days=1)))
    session.flush()

    assert is_snoozed(session, rule_id=rule.id, product_key=None, now=NOW) is False


def test_snooze_of_another_product_does_not_affect(session: Session) -> None:
    rule = _rule(session)
    session.add(Snooze(scope="product", product_key="outro-produto", until=NOW + timedelta(days=1)))
    session.flush()

    assert is_snoozed(session, rule_id=rule.id, product_key="palit-rtx-5070-ti", now=NOW) is False


def test_no_product_key_is_never_matched_by_a_product_snooze(session: Session) -> None:
    rule = _rule(session)
    session.add(
        Snooze(scope="product", product_key="palit-rtx-5070-ti", until=NOW + timedelta(days=1))
    )
    session.flush()

    assert is_snoozed(session, rule_id=rule.id, product_key=None, now=NOW) is False


def test_target_hit_always_pierces_an_active_snooze(session: Session) -> None:
    """S14-03 decision (2026-09-23): a price target reached fires through any
    active snooze. S14-02 (price target) wires `target_hit` up; this only
    guarantees the flag already does the right thing here.
    """
    rule = _rule(session)
    session.add(Snooze(scope="rule", rule_id=rule.id, until=NOW + timedelta(days=1)))
    session.flush()

    assert (
        is_snoozed(session, rule_id=rule.id, product_key=None, now=NOW, target_hit=True) is False
    )
