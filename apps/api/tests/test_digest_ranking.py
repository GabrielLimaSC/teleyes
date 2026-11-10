"""S27-01: digest content — discount ranking, rule variety, one item per
product, clean titles, honest wording and the bait-price guard."""

from datetime import UTC, datetime, timedelta

from sqlalchemy.orm import Session

from app.digest import build_digest_text, load_pending_queue, split_top_and_overflow
from app.digest_ranking import clean_title
from app.pipeline import DELIVERY_KIND_DIGEST
from models import Delivery, Match, Recipient, Rule, Source

NOW = datetime(2026, 11, 10, 12, 0, tzinfo=UTC)


def _world(session: Session, *, rules: int = 1) -> tuple[Source, list[Rule], Recipient]:
    source = Source(name="Grupo", telegram_chat_id="-100")
    rule_rows = [Rule(name=f"Regra {i}", include_terms=f"termo{i}") for i in range(rules)]
    recipient = Recipient(name="Gabriel", telegram_chat_id="999", allowlisted=True)
    session.add_all([source, recipient, *rule_rows])
    session.flush()
    return source, rule_rows, recipient


_counter = {"n": 0}


def _match(
    session: Session,
    source: Source,
    rule: Rule,
    *,
    price: int | None,
    key: str | None,
    text: str = "Produto",
    days_ago: int = 1,
) -> Match:
    _counter["n"] += 1
    match = Match(
        source_id=source.id,
        rule_id=rule.id,
        telegram_message_id=_counter["n"],
        message_text=text,
        price_cents=price,
        product_key=key,
        message_link=None,
        matched_at=NOW - timedelta(days=days_ago),
    )
    session.add(match)
    session.flush()
    return match


def _history(session: Session, source: Source, rule: Rule, key: str, prices: list[int]) -> None:
    for price in prices:
        _match(session, source, rule, price=price, key=key, days_ago=10)


def _queue(session: Session, recipient: Recipient, *matches: Match) -> None:
    for match in matches:
        session.add(
            Delivery(
                match_id=match.id,
                recipient_id=recipient.id,
                kind=DELIVERY_KIND_DIGEST,
                status="pending",
            )
        )
    session.commit()


def _ids(session: Session) -> list[int]:
    return [item.match_id for item in load_pending_queue(session, now=NOW)]


def test_orders_by_relative_discount_not_absolute_price(session: Session) -> None:
    source, (rule,), recipient = _world(session)
    _history(session, source, rule, "mobo", [50_000, 52_000, 48_000])
    _history(session, source, rule, "gpu", [300_000, 310_000, 290_000])
    cheap_small_discount = _match(session, source, rule, price=47_000, key="mobo")  # ~6%
    pricey_big_discount = _match(session, source, rule, price=210_000, key="gpu")  # ~30%
    _queue(session, recipient, cheap_small_discount, pricey_big_discount)

    queue = load_pending_queue(session, now=NOW)

    assert [i.match_id for i in queue] == [pricey_big_discount.id, cheap_small_discount.id]
    assert queue[0].discount_pct == 30.0
    assert queue[0].reference_kind == "median"
    assert "30% abaixo da mediana vista" in build_digest_text(queue)


def test_rule_target_is_the_reference_when_the_product_has_no_history(session: Session) -> None:
    source, (rule,), recipient = _world(session)
    rule.target_price_cents = 100_000
    match = _match(session, source, rule, price=80_000, key="novo")
    _queue(session, recipient, match)

    (item,) = load_pending_queue(session, now=NOW)

    assert item.reference_kind == "target"
    assert item.discount_pct == 20.0
    assert "20% abaixo do alvo" in build_digest_text([item])


def test_item_without_reference_goes_last_ordered_by_price(session: Session) -> None:
    source, (rule,), recipient = _world(session)
    _history(session, source, rule, "gpu", [300_000, 310_000, 290_000])
    with_ref = _match(session, source, rule, price=270_000, key="gpu")
    no_ref_dear = _match(session, source, rule, price=90_000, key="a")
    no_ref_cheap = _match(session, source, rule, price=10_000, key="b")
    unpriced = _match(session, source, rule, price=None, key="c")
    _queue(session, recipient, unpriced, no_ref_dear, with_ref, no_ref_cheap)

    queue = load_pending_queue(session, now=NOW)

    assert [i.match_id for i in queue] == [
        with_ref.id,
        no_ref_cheap.id,
        no_ref_dear.id,
        unpriced.id,
    ]
    assert "abaixo" not in build_digest_text(queue[1:])


def test_bait_price_never_leads_and_is_not_called_a_discount(session: Session) -> None:
    source, (rule,), recipient = _world(session)
    _history(session, source, rule, "gpu", [300_000, 310_000, 290_000])
    _history(session, source, rule, "ssd", [40_000, 42_000, 38_000])
    bait = _match(session, source, rule, price=200, key="gpu")  # R$ 2,00 < 25% of median
    honest = _match(session, source, rule, price=36_000, key="ssd")  # 10%
    no_ref = _match(session, source, rule, price=5_000, key="outro")
    _queue(session, recipient, bait, honest, no_ref)

    queue = load_pending_queue(session, now=NOW)

    assert [i.match_id for i in queue] == [honest.id, no_ref.id, bait.id]
    assert queue[-1].suspected_bait is True
    assert "abaixo" not in build_digest_text(queue[-1:])


def test_bait_in_the_history_does_not_drag_the_reference_down(session: Session) -> None:
    source, (rule,), recipient = _world(session)
    _history(session, source, rule, "gpu", [300_000, 310_000, 290_000, 300_000, 100])
    match = _match(session, source, rule, price=240_000, key="gpu")
    _queue(session, recipient, match)

    (item,) = load_pending_queue(session, now=NOW)

    assert item.reference_cents == 300_000
    assert item.discount_pct == 20.0


def test_a_single_rule_cannot_fill_the_digest(session: Session) -> None:
    source, (rule_a, rule_b, rule_c), recipient = _world(session, rules=3)
    dominant = []
    for index in range(4):
        key = f"a{index}"
        _history(session, source, rule_a, key, [100_000, 100_000, 100_000])
        dominant.append(_match(session, source, rule_a, price=50_000 - index * 1000, key=key))
    _history(session, source, rule_b, "b", [100_000, 100_000, 100_000])
    _history(session, source, rule_c, "c", [100_000, 100_000, 100_000])
    from_b = _match(session, source, rule_b, price=80_000, key="b")
    from_c = _match(session, source, rule_c, price=90_000, key="c")
    _queue(session, recipient, *dominant, from_b, from_c)

    top, overflow = split_top_and_overflow(load_pending_queue(session, now=NOW), 3)

    assert {i.rule_id for i in top} == {rule_a.id, rule_b.id, rule_c.id}
    assert len(top) == 3
    assert len(overflow) == 3


def test_one_item_per_product_keeps_the_best_offer_and_retires_the_rest(
    session: Session,
) -> None:
    source, (rule,), recipient = _world(session)
    _history(session, source, rule, "gpu", [300_000, 310_000, 290_000])
    best = _match(session, source, rule, price=240_000, key="gpu")
    worse = _match(session, source, rule, price=270_000, key="gpu")
    other = _match(session, source, rule, price=5_000, key="cabo")
    _queue(session, recipient, worse, best, other)

    queue = load_pending_queue(session, now=NOW)
    top, overflow = split_top_and_overflow(queue, 3)

    assert [i.match_id for i in top] == [best.id, other.id]
    assert [i.match_id for i in overflow] == [worse.id]
    assert overflow[0].superseded is True


def test_matches_without_product_key_are_never_merged(session: Session) -> None:
    source, (rule,), recipient = _world(session)
    first = _match(session, source, rule, price=10_000, key=None)
    second = _match(session, source, rule, price=20_000, key=None)
    _queue(session, recipient, first, second)

    top, overflow = split_top_and_overflow(load_pending_queue(session, now=NOW), 5)

    assert len(top) == 2
    assert overflow == ()


def test_clean_title_strips_markdown_emoji_and_extra_spaces() -> None:
    raw = "🔥🔥 **Placa de Vídeo**   __Palit__ ~~RTX~~ `5070` 12GB ⚡️"

    assert clean_title(raw) == "Placa de Vídeo Palit RTX 5070 12GB"


def test_clean_title_truncates_on_a_word_with_an_ellipsis() -> None:
    title = clean_title("Processador AMD Ryzen 7 9800X3D 8 núcleos 5.2GHz cache 96MB " * 3)

    assert len(title) <= 70
    assert title.endswith("…")
    assert "  " not in title


def test_titles_in_the_queue_are_clean(session: Session) -> None:
    source, (rule,), recipient = _world(session)
    match = _match(
        session, source, rule, price=10_000, key=None, text="🔥 **SSD Kingston 1TB** 🔥\nR$ 300"
    )
    _queue(session, recipient, match)

    (item,) = load_pending_queue(session, now=NOW)

    assert "*" not in item.title
    assert "🔥" not in item.title
    assert "SSD Kingston 1TB" in item.title
