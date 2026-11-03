"""S21-06 (F8): which recipients a match is delivered to.

Rule of delivery, from the design:

    (recipients on "all" ∪ recipients on "selected" that picked the rule)
      − paused (inactive) − not allowlisted − snoozed rule

then filtered by alert type: a price-target hit reaches people with
`notify_target`, a common match reaches people with `notify_common`. The
silence of the rule is applied by the pipeline (`app.delivery_policy.is_snoozed`,
which a target hit pierces); everything else is `recipients_for_match` below.

The global digest setting stays the *channel* of a common match (digest or
immediate); F8 only decides per person whether they get the common match at all.
"""

from collections.abc import Collection, Iterable, Mapping, Sequence
from typing import NamedTuple, Protocol

from sqlalchemy import select
from sqlalchemy.orm import Session

from models import Recipient, RecipientRule
from models.recipient import RULES_MODE_ALL, RULES_MODE_SELECTED

RULES_MODES = (RULES_MODE_ALL, RULES_MODE_SELECTED)


class DeliveryPrefs(Protocol):
    """The recipient fields the delivery rule reads (a `Recipient` row fits)."""

    @property
    def id(self) -> int: ...
    @property
    def active(self) -> bool: ...
    @property
    def allowlisted(self) -> bool: ...
    @property
    def rules_mode(self) -> str: ...
    @property
    def notify_target(self) -> bool: ...
    @property
    def notify_common(self) -> bool: ...


class RecipientPrefs(NamedTuple):
    """A fresh read of those fields, detached from any session."""

    id: int
    active: bool
    allowlisted: bool
    rules_mode: str
    notify_target: bool
    notify_common: bool



def recipient_gets_rule(
    recipient: DeliveryPrefs, rule_id: int, selected_rule_ids: Collection[int]
) -> bool:
    if recipient.rules_mode == RULES_MODE_SELECTED:
        return rule_id in selected_rule_ids
    return True


def recipient_gets_kind(recipient: DeliveryPrefs, *, is_target_hit: bool) -> bool:
    return recipient.notify_target if is_target_hit else recipient.notify_common


def recipients_for_match[P: DeliveryPrefs](
    recipients: Iterable[P],
    *,
    rule_id: int,
    is_target_hit: bool,
    selected_rule_ids: Mapping[int, Collection[int]],
) -> list[P]:
    """Pure: the subset of `recipients` that receives this match."""
    return [
        recipient
        for recipient in recipients
        if recipient.active
        and recipient.allowlisted
        and recipient_gets_rule(recipient, rule_id, selected_rule_ids.get(recipient.id, ()))
        and recipient_gets_kind(recipient, is_target_hit=is_target_hit)
    ]


def load_selected_rule_ids(session: Session) -> dict[int, set[int]]:
    result: dict[int, set[int]] = {}
    for recipient_id, rule_id in session.execute(
        select(RecipientRule.recipient_id, RecipientRule.rule_id)
    ):
        result.setdefault(recipient_id, set()).add(rule_id)
    return result


def eligible_recipients(
    session: Session, candidates: Sequence[Recipient], *, rule_id: int, is_target_hit: bool
) -> list[Recipient]:
    """`candidates` (the listener's loaded recipients) filtered against the
    *current* database state, so a change made in the panel takes effect on the
    next match without waiting for "Aplicar regras". Returns the candidates
    themselves (not fresh ORM rows), so nothing new gets attached to `session`.
    """
    if not candidates:
        return []
    by_id = {recipient.id: recipient for recipient in candidates}
    prefs = [
        RecipientPrefs(*row)
        for row in session.execute(
            select(
                Recipient.id,
                Recipient.active,
                Recipient.allowlisted,
                Recipient.rules_mode,
                Recipient.notify_target,
                Recipient.notify_common,
            )
            .where(Recipient.id.in_(by_id))
            .order_by(Recipient.id)
        )
    ]
    chosen = recipients_for_match(
        prefs,
        rule_id=rule_id,
        is_target_hit=is_target_hit,
        selected_rule_ids=load_selected_rule_ids(session),
    )
    return [by_id[pref.id] for pref in chosen]
