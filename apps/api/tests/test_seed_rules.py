import sys
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from models import Rule

# scripts/ isn't a package under apps/api (pytest's pythonpath), so it's not
# importable the normal way — added to sys.path just for this test file,
# same convention as test_create_admin.py.
sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "scripts"))
from seed_rules import (  # type: ignore[import-not-found]  # noqa: E402
    DEFAULT_RULES,
    seed_default_rules,
)


def test_creates_every_default_rule_on_a_clean_database(session: Session) -> None:
    results = seed_default_rules(session)
    session.commit()

    assert set(results.values()) == {"criada"}
    assert set(results.keys()) == {name for name, _, _ in DEFAULT_RULES}
    rules = session.scalars(select(Rule)).all()
    assert {rule.name for rule in rules} == {name for name, _, _ in DEFAULT_RULES}


def test_running_twice_does_not_duplicate_rules(session: Session) -> None:
    seed_default_rules(session)
    session.commit()

    results = seed_default_rules(session)
    session.commit()

    assert set(results.values()) == {"já existia"}
    rules = session.scalars(select(Rule)).all()
    assert len(rules) == len(DEFAULT_RULES)


def test_never_overwrites_a_rule_edited_through_the_panel(session: Session) -> None:
    seed_default_rules(session)
    session.commit()

    edited = session.scalar(select(Rule).where(Rule.name == "RTX 5070 12GB"))
    assert edited is not None
    edited.include_terms = "termo editado pelo gabriel"
    session.commit()

    seed_default_rules(session)
    session.commit()

    reloaded = session.scalar(select(Rule).where(Rule.name == "RTX 5070 12GB"))
    assert reloaded is not None
    assert reloaded.include_terms == "termo editado pelo gabriel"


def test_rtx_5070_ti_messages_do_not_also_trigger_the_12gb_rule(session: Session) -> None:
    from packages.rules.match import MatchRule

    seed_default_rules(session)
    session.commit()

    rule_12gb = session.scalar(select(Rule).where(Rule.name == "RTX 5070 12GB"))
    assert rule_12gb is not None
    match_rule = MatchRule(
        include_terms=rule_12gb.include_terms.split(","),
        exclude_terms=(rule_12gb.exclude_terms or "").split(","),
    )

    assert match_rule.matches("Promoção RTX 5070 12GB por R$ 3.500") is True
    assert match_rule.matches("Promoção RTX 5070 Ti por R$ 4.500") is False
