"""S14-02: pure price-target math (F6).

Shared by `app.pipeline`'s delivery decision and the feed's `target_hit`/
`target_gap_pct` fields (`app.routers.matches`), so the two can never
disagree about what "hit" or "gap" means. No fuzzy matching, no side effects
(CLAUDE.md) — a target is a plain integer comparison in cents.
"""


def target_hit(price_cents: int | None, target_price_cents: int | None) -> bool:
    """A rule's target is reached once a match's price is at or below it.

    `False` with no target set or no extracted price — a priceless match can
    never claim a target hit, the same reasoning `app.pipeline`'s grouping
    anchor already uses for `price_cents is None`.
    """
    return (
        price_cents is not None
        and target_price_cents is not None
        and price_cents <= target_price_cents
    )


def target_gap_pct(price_cents: int | None, target_price_cents: int | None) -> int | None:
    """Integer percent still missing to reach the target, floored.

    E.g. target 2050 and price 2249 is 9, not 10: 199/2050 = 9.7%, truncated
    towards the target rather than rounded up, so "almost there" never reads
    as farther away than it really is. `None` with no target, no price, or a
    non-positive target (a target price is always a strictly positive
    amount once set — enforced by the CRUD, `repositories.rule_repo`). `0`
    once the target is already hit — nothing left to close.
    """
    if price_cents is None or target_price_cents is None or target_price_cents <= 0:
        return None
    if price_cents <= target_price_cents:
        return 0
    return ((price_cents - target_price_cents) * 100) // target_price_cents
