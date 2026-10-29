"""S19-03: the demo seed is deterministic, fictional and tells the intended story."""

import random
import re
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path
from subprocess import CompletedProcess

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from app.demo_mode import DEMO_PASSWORD, DemoNotifier
from app.demo_seed import (
    SEED,
    DemoReplayer,
    UnsafeDatabaseError,
    content_hash,
    is_seeded,
    seed_demo_database,
)
from app.utc import ensure_utc
from auth.hashing import verify_password
from models import Admin, Delivery, Match, Purchase, Recipient, Rule, Snooze, Source
from models.db import get_engine, get_sessionmaker
from packages.metrics.counters import MetricCounter
from packages.rules.target import target_hit

NOW = datetime(2026, 6, 1, 15, 30, tzinfo=UTC)
AlembicRunner = Callable[..., CompletedProcess[str]]


def _fresh_factory(
    tmp_path: Path, alembic_runner: AlembicRunner, name: str
) -> sessionmaker[Session]:
    url = f"sqlite:///{tmp_path / name}"
    alembic_runner("upgrade", "head", database_url=url)
    return get_sessionmaker(get_engine(url))


@pytest.fixture
def seeded(tmp_path: Path, alembic_runner: AlembicRunner) -> sessionmaker[Session]:
    factory = _fresh_factory(tmp_path, alembic_runner, "demo.db")
    seed_demo_database(factory, now=NOW)
    return factory


def test_two_runs_produce_identical_content(
    seeded: sessionmaker[Session], tmp_path: Path, alembic_runner: AlembicRunner
) -> None:
    other = _fresh_factory(tmp_path, alembic_runner, "other.db")
    seed_demo_database(other, now=NOW)

    with seeded() as first, other() as second:
        assert content_hash(first) == content_hash(second)


def test_seeding_again_is_a_no_op(seeded: sessionmaker[Session]) -> None:
    with seeded() as session:
        before = content_hash(session)

    # Even at a different "now": an already-seeded demo database is left alone.
    seed_demo_database(seeded, now=NOW + timedelta(days=3))

    with seeded() as session:
        assert content_hash(session) == before


def test_force_reseeds_with_the_new_now(seeded: sessionmaker[Session]) -> None:
    with seeded() as session:
        before = content_hash(session)

    seed_demo_database(seeded, now=NOW + timedelta(days=3), force=True)

    with seeded() as session:
        assert content_hash(session) != before
        assert is_seeded(session)


def test_counts_and_shape(seeded: sessionmaker[Session]) -> None:
    with seeded() as session:
        rules = list(session.scalars(select(Rule)))
        sources = list(session.scalars(select(Source)))
        recipients = list(session.scalars(select(Recipient)))
        matches = list(session.scalars(select(Match)))

        assert 4 <= len(rules) <= 5
        assert any(not rule.active for rule in rules)
        assert all(rule.target_price_cents and rule.max_price_cents for rule in rules)
        assert session.scalar(select(Snooze).where(Snooze.until > NOW)) is not None
        assert 3 <= len(sources) <= 4 and all(source.active for source in sources)
        assert len(recipients) == 2 and all(r.allowlisted for r in recipients)
        assert 120 <= len(matches) <= 200
        # Spans the whole window and uses both price shapes.
        oldest = min(ensure_utc(m.matched_at) for m in matches)
        assert NOW - oldest > timedelta(days=80)
        assert any(m.price_cash_cents and m.price_card_cents for m in matches)
        assert any(m.price_cents and not m.price_cash_cents for m in matches)
        assert any("Cupom" in m.message_text for m in matches)
        assert max(ensure_utc(m.matched_at) for m in matches) <= NOW
        assert session.scalar(select(Admin)) is not None


def test_deliveries_have_a_realistic_mix(seeded: sessionmaker[Session]) -> None:
    with seeded() as session:
        pairs = {(d.status, d.kind) for d in session.scalars(select(Delivery))}
        failed = [d for d in session.scalars(select(Delivery)) if d.status == "failed"]

    assert {("sent", "immediate"), ("sent", "target"), ("grouped", "immediate")} <= pairs
    assert ("historical", "immediate") in pairs
    assert ("sent", "digest") in pairs
    assert failed and all(d.delivered_at is None for d in failed)


def test_healthy_listener_and_counters(seeded: sessionmaker[Session]) -> None:
    with seeded() as session:
        from models import ListenerControl

        control = session.get(ListenerControl, 1)
        assert control is not None and control.state == "idle"
        assert ensure_utc(control.listener_seen_at) == NOW  # type: ignore[arg-type]
        counters = list(session.scalars(select(MetricCounter)))

    reasons = {counter.reason for counter in counters}
    assert {"vista", "sem_termo", "bloqueado", "preco_acima_teto", "falha_entrega"} <= reasons
    assert all(counter.count > 0 for counter in counters)


def test_live_target_hits_in_the_last_24h_and_older_ones(seeded: sessionmaker[Session]) -> None:
    with seeded() as session:
        rules = {rule.id: rule for rule in session.scalars(select(Rule))}
        recent_hit_rules: set[int] = set()
        old_hit_rules: set[int] = set()
        for match in session.scalars(select(Match)):
            rule = rules[match.rule_id]
            if not target_hit(match.price_cents, rule.target_price_cents):
                continue
            if NOW - ensure_utc(match.matched_at) <= timedelta(hours=24):
                recent_hit_rules.add(rule.id)
            else:
                old_hit_rules.add(rule.id)

    assert len(recent_hit_rules) >= 2
    # At least one rule hit its target before, but not within the last 24 h.
    assert old_hit_rules - recent_hit_rules


def test_nothing_in_the_seed_looks_real(seeded: sessionmaker[Session]) -> None:
    with seeded() as session:
        texts = [m.message_text for m in session.scalars(select(Match))]
        texts += [m.message_link or "" for m in session.scalars(select(Match))]
        texts += [r.name for r in session.scalars(select(Rule))]
        texts += [r.include_terms for r in session.scalars(select(Rule))]
        names = [s.name for s in session.scalars(select(Source))]
        names += [r.name for r in session.scalars(select(Recipient))]
        chat_ids = [s.telegram_chat_id for s in session.scalars(select(Source))]
        chat_ids += [r.telegram_chat_id for r in session.scalars(select(Recipient))]

    blob = "\n".join(texts + names)
    assert "@" not in blob
    assert not re.search(r"t\.me|telegram\.(me|org)|wa\.me", blob, re.IGNORECASE)
    urls = re.findall(r"https?://\S+", blob)
    assert urls and all(url.startswith("https://example.com/") for url in urls)
    # No phone- or Telegram-id-shaped numbers anywhere in names or ids.
    assert not re.search(r"\d{8,}", "\n".join(names + chat_ids))
    assert all(chat_id.startswith("demo:") for chat_id in chat_ids)
    assert all("Demo" in n or "Exemplo" in n or "Fictícias" in n for n in names)
    product_lines = [text.splitlines()[0] for text in texts if text.startswith("🔥")]
    assert product_lines and all("exemplo" in line.lower() for line in product_lines)


def test_demo_admin_uses_the_public_demo_password(seeded: sessionmaker[Session]) -> None:
    with seeded() as session:
        admin = session.scalar(select(Admin))
        assert admin is not None
        assert verify_password(DEMO_PASSWORD, admin.password_hash)
        assert not verify_password("outra-senha", admin.password_hash)


def test_refuses_a_database_with_a_real_looking_source(
    tmp_path: Path, alembic_runner: AlembicRunner
) -> None:
    factory = _fresh_factory(tmp_path, alembic_runner, "real.db")
    with factory() as session:
        session.add(Source(name="Grupo de verdade", telegram_chat_id="-1001234567890"))
        session.commit()

    for force in (False, True):
        with pytest.raises(UnsafeDatabaseError):
            seed_demo_database(factory, now=NOW, force=force)

    with factory() as session:
        assert len(list(session.scalars(select(Match)))) == 0


def test_refuses_leftovers_without_force_but_not_with_it(
    tmp_path: Path, alembic_runner: AlembicRunner
) -> None:
    factory = _fresh_factory(tmp_path, alembic_runner, "leftover.db")
    with factory() as session:
        session.add(Rule(name="Regra solta", include_terms="x"))
        session.commit()

    with pytest.raises(UnsafeDatabaseError):
        seed_demo_database(factory, now=NOW)

    seed_demo_database(factory, now=NOW, force=True)
    with factory() as session:
        assert is_seeded(session)


async def test_replayer_inserts_a_fictional_match_without_any_network(
    seeded: sessionmaker[Session], monkeypatch: pytest.MonkeyPatch
) -> None:
    import socket

    def no_network(*args: object, **kwargs: object) -> None:
        raise AssertionError("demo mode must not open a network connection")

    monkeypatch.setattr(socket.socket, "connect", no_network)
    with seeded() as session:
        before = len(list(session.scalars(select(Match))))

    replayer = DemoReplayer(
        seeded, rng=random.Random(SEED), clock=lambda: NOW + timedelta(minutes=5)
    )
    match_id = await replayer.tick()

    assert match_id is not None
    with seeded() as session:
        assert len(list(session.scalars(select(Match)))) == before + 1
        deliveries = list(session.scalars(select(Delivery).where(Delivery.match_id == match_id)))
    assert deliveries and all(d.status in {"sent", "grouped"} for d in deliveries)
    assert 20 <= replayer.next_delay_seconds() <= 40


async def test_demo_notifier_reports_sent_without_a_client() -> None:
    notifier = DemoNotifier()

    result = await notifier.notify(match_id=1, recipient_id=1, chat_id="demo:recipient-1", text="x")

    assert result.delivered is True
    assert notifier._client is None
    assert (await notifier.notify_digest("demo:recipient-1", "x")).delivered is True
    await notifier.notify_operational("x")


def test_seed_registers_fictional_purchases_linked_to_the_seeded_history(
    seeded: sessionmaker[Session],
) -> None:
    with seeded() as session:
        purchases = list(session.scalars(select(Purchase).order_by(Purchase.id)))
        known_keys = set(session.scalars(select(Match.product_key).distinct()))

    assert len(purchases) >= 4
    assert all("exemplo" in purchase.name.lower() for purchase in purchases)
    assert all(purchase.price_cents > 0 for purchase in purchases)
    linked = [purchase for purchase in purchases if purchase.product_key is not None]
    assert linked and all(purchase.product_key in known_keys for purchase in linked)
    assert any(purchase.product_key is None for purchase in purchases)
