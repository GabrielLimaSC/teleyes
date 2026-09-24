from collections.abc import Sequence

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from models import Delivery, Match, Rule
from repositories.errors import NotFoundError, ValidationError


def _validate_target_price_cents(target_price_cents: int | None) -> None:
    if target_price_cents is not None and target_price_cents <= 0:
        raise ValidationError("target_price_cents must be greater than zero")


def create_rule(
    session: Session,
    *,
    name: str,
    include_terms: str,
    exclude_terms: str | None = None,
    max_price_cents: int | None = None,
    target_price_cents: int | None = None,
) -> Rule:
    if not include_terms.strip():
        raise ValidationError("rule requires at least one include term")
    _validate_target_price_cents(target_price_cents)

    rule = Rule(
        name=name,
        include_terms=include_terms,
        exclude_terms=exclude_terms,
        max_price_cents=max_price_cents,
        target_price_cents=target_price_cents,
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
    target_price_cents: int | None = None,
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
    if target_price_cents is not None:
        _validate_target_price_cents(target_price_cents)
        rule.target_price_cents = target_price_cents

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


def clear_rule_matches(session: Session, rule_id: int) -> int:
    """S10-04: deletes every `Match` (and its `Delivery` rows) for one rule —
    the rule itself, its config and its `active` state are untouched, only
    its match history. `Delivery` rows are deleted first: `Match`/`Delivery`
    have no DB-level cascade (no `ondelete="CASCADE"` on the FK), so a plain
    delete of `Match` alone would leave orphaned `Delivery` rows behind.
    Returns the number of matches deleted, for the frontend's confirmation
    dialog and the success toast.
    """
    _get_rule(session, rule_id)
    match_ids = list(session.scalars(select(Match.id).where(Match.rule_id == rule_id)))
    if not match_ids:
        return 0
    session.execute(delete(Delivery).where(Delivery.match_id.in_(match_ids)))
    session.execute(delete(Match).where(Match.rule_id == rule_id))
    session.flush()
    return len(match_ids)
