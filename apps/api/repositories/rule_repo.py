from collections.abc import Sequence

from sqlalchemy import select
from sqlalchemy.orm import Session

from models import Rule
from repositories.errors import NotFoundError, ValidationError


def create_rule(
    session: Session,
    *,
    name: str,
    include_terms: str,
    exclude_terms: str | None = None,
    max_price_cents: int | None = None,
) -> Rule:
    if not include_terms.strip():
        raise ValidationError("rule requires at least one include term")

    rule = Rule(
        name=name,
        include_terms=include_terms,
        exclude_terms=exclude_terms,
        max_price_cents=max_price_cents,
    )
    session.add(rule)
    session.flush()
    return rule


def list_rules(session: Session, *, include_inactive: bool = False) -> Sequence[Rule]:
    stmt = select(Rule)
    if not include_inactive:
        stmt = stmt.where(Rule.active.is_(True))
    return session.scalars(stmt).all()


def _get_rule(session: Session, rule_id: int) -> Rule:
    rule = session.get(Rule, rule_id)
    if rule is None:
        raise NotFoundError(f"rule {rule_id} not found")
    return rule


def update_rule(
    session: Session,
    rule_id: int,
    *,
    name: str | None = None,
    include_terms: str | None = None,
    exclude_terms: str | None = None,
    max_price_cents: int | None = None,
) -> Rule:
    rule = _get_rule(session, rule_id)

    if include_terms is not None:
        if not include_terms.strip():
            raise ValidationError("rule requires at least one include term")
        rule.include_terms = include_terms
    if name is not None:
        rule.name = name
    if exclude_terms is not None:
        rule.exclude_terms = exclude_terms
    if max_price_cents is not None:
        rule.max_price_cents = max_price_cents

    session.flush()
    return rule


def pause_rule(session: Session, rule_id: int) -> Rule:
    rule = _get_rule(session, rule_id)
    rule.active = False
    session.flush()
    return rule


def delete_rule(session: Session, rule_id: int) -> None:
    rule = _get_rule(session, rule_id)
    session.delete(rule)
    session.flush()
