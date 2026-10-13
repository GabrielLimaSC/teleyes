"""S14-03 (F3): whether a delivery is currently silenced by an active snooze.

Silencing only ever suppresses the *delivery* — the match itself is always
persisted and published on SSE exactly as if nothing were snoozed. The only
caller today is `app.pipeline.process_message`, right before it would
otherwise create or enqueue a `Delivery`.
"""

from datetime import datetime

from sqlalchemy import and_, or_, select
from sqlalchemy.orm import Session

from models import Snooze


def is_snoozed(
    session: Session,
    *,
    rule_id: int,
    product_key: str | None,
    now: datetime,
    target_hit: bool = False,
) -> bool:
    """Whether the rule or the product is silenced at `now`.

    Checks both an active rule-scoped snooze (`rule_id`) and, when the match
    has one, an active product-scoped snooze (`product_key`) — either alone
    is enough to silence. "Active" means `until > now`; an expired snooze is
    treated as if it did not exist, with no cleanup job (S14 decision): it
    stays in the table until "Reativar" deletes it or a new snooze for the
    same target replaces it.

    `target_hit=True` always returns `False`: Gabriel's decision (2026-09-23)
    that a price target reached fires through any active snooze. The pipeline
    itself does not compute `target_hit` yet (that lands with the price
    target in S14-02) — this parameter is only wired up here so that task
    only has to pass the flag, not touch this function.
    """
    if target_hit:
        return False

    targets = [and_(Snooze.scope == "rule", Snooze.rule_id == rule_id)]
    if product_key is not None:
        targets.append(and_(Snooze.scope == "product", Snooze.product_key == product_key))

    statement = select(Snooze.id).where(Snooze.until > now, or_(*targets)).limit(1)
    return session.scalar(statement) is not None
