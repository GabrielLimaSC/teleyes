"""S19-03: deterministic, 100% fictional demo data, built with the real pipeline.

`seed_demo_database` feeds fictional Telegram messages (chronologically, over the
last 90 days relative to `now`) through `app.pipeline.process_message` with a
no-op notifier, so rules, price extraction (cash vs card, coupons), duplicate
grouping, target alerts, product keys and metric counters are produced by the
exact code the real listener uses — nothing is hand-written into those tables.
Only what the pipeline cannot know afterwards is adjusted: timestamps, a handful
of failed/historical/digest delivery states, aggregate counters for the
traffic that never matched anything, and the listener heartbeat.

Everything is fictional: invented stores, groups and products (every product
name carries the word "Exemplo"), chat ids starting with `demo:` and links under
`https://example.com/`. The RNG is seeded, so the same `now` always yields the
same database content.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import math
import random
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.orm import Session, sessionmaker

from app.demo_mode import DEMO_CHAT_PREFIX, DEMO_PASSWORD, DemoNotifier, is_demo_chat_id
from app.listener_control import current_fingerprint
from app.pipeline import IncomingMessage, process_message
from app.savings import Observation, median
from app.utc import ensure_utc
from auth.hashing import hash_password
from models import (
    Admin,
    Base,
    Delivery,
    DigestSettings,
    ListenerControl,
    Match,
    ProcessingCursor,
    Purchase,
    Recipient,
    Rule,
    Snooze,
    Source,
)
from models.digest_settings import DIGEST_SETTINGS_ID
from models.listener_control import LISTENER_CONTROL_ID
from packages.metrics.counters import MetricCounter, MetricReason
from packages.notifications.formatting import format_price_cents
from packages.rules.dedupe import DedupeCache
from repositories import recipient_repo, rule_repo, source_repo

SEED = 20260514
HISTORY_DAYS = 90
# What the "old" database looked like when the demo was created: everything is
# stamped this many days before `now`.
CREATED_DAYS_AGO = 95
PAUSED_RULE_DAYS_AGO = 9

SOURCE_NAMES = (
    "Grupo Demo Ofertas",
    "Canal Exemplo Hardware",
    "Promoções Fictícias Tech",
    "Achados Demo Informática",
)
RECIPIENT_NAMES = ("Alex Exemplo (principal)", "Sam Exemplo (secundário)")
STORES = (
    "Loja Exemplo",
    "MegaStore Demo",
    "Tech Fictícia",
    "Mercado Demo",
    "Casa do Hardware Exemplo",
)


@dataclass(frozen=True)
class RuleSpec:
    key: str
    name: str
    include_terms: str
    exclude_terms: str | None
    ceiling_reais: int
    target_reais: int
    base_reais: int  # typical price at the start of the window
    trend: float  # fraction the typical price falls over the window
    titles: tuple[str, ...]
    random_events: int
    active: bool = True


RULE_SPECS: tuple[RuleSpec, ...] = (
    RuleSpec(
        key="rtx",
        name="Placa de vídeo RTX 5090 exemplo",
        include_terms="rtx 5090 exemplo",
        exclude_terms="notebook,usada",
        ceiling_reais=22_000,
        target_reais=16_500,
        base_reais=18_300,
        trend=0.07,
        titles=(
            "Placa de Vídeo Orion GeForce RTX 5090 Exemplo 32GB GDDR7",
            "Placa de Vídeo Nimbus RTX 5090 Exemplo OC 32GB",
            "VGA Vértice RTX 5090 Exemplo Gaming 32GB",
        ),
        random_events=24,
    ),
    RuleSpec(
        key="notebook",
        name="Notebook exemplo 15 polegadas",
        include_terms="notebook + exemplo + 15 polegadas",
        exclude_terms="recondicionado,usado",
        ceiling_reais=7_500,
        target_reais=3_800,
        base_reais=4_900,
        trend=0.08,
        titles=(
            "Notebook Exemplo 15 polegadas Aurora AX1500 i7 16GB 512GB",
            "Notebook Exemplo 15 polegadas Nimbus NB1520 Ryzen 7 16GB 1TB",
            "Notebook Exemplo 15 polegadas Orion OR1580 i5 16GB 512GB",
        ),
        random_events=28,
    ),
    RuleSpec(
        key="fone",
        name="Fone bluetooth exemplo",
        include_terms="fone bluetooth exemplo,headset bluetooth exemplo",
        exclude_terms="infantil",
        ceiling_reais=600,
        target_reais=199,
        base_reais=289,
        trend=0.10,
        titles=(
            "Fone Bluetooth Exemplo Pulse PX200 com cancelamento de ruído",
            "Headset Bluetooth Exemplo Nimbus NH30 Gamer",
            "Fone Bluetooth Exemplo Vértice VT90 TWS",
        ),
        random_events=30,
    ),
    RuleSpec(
        key="monitor",
        name="Monitor 27 exemplo",
        include_terms="monitor + 27 + exemplo",
        exclude_terms=None,
        ceiling_reais=2_800,
        target_reais=899,
        base_reais=1_390,
        trend=0.05,
        titles=(
            "Monitor Gamer Exemplo 27 polegadas QHD 165Hz Aurora MG27Q",
            "Monitor Exemplo 27 polegadas IPS 144Hz Orion OM27",
        ),
        random_events=16,
        active=False,
    ),
    RuleSpec(
        key="ssd",
        name="SSD NVMe exemplo",
        include_terms="ssd nvme exemplo",
        exclude_terms="externo",
        ceiling_reais=900,
        target_reais=349,
        base_reais=489,
        trend=0.12,
        titles=(
            "SSD NVMe Exemplo Vértice VX1000 1TB Gen4",
            "SSD NVMe Exemplo Orion OR2000 2TB Gen4",
            "SSD NVMe Exemplo Nimbus NS1000 1TB Gen3",
        ),
        random_events=28,
    ),
)
SPEC_BY_KEY = {spec.key: spec for spec in RULE_SPECS}


# --- message building ---------------------------------------------------------


def round_price_cents(reais: float) -> int:
    """Shop-style price: 16.499,00 for big tickets, 289,90 for small ones."""
    if reais >= 1_000:
        return (round(reais / 10) * 10 - 1) * 100
    return round(reais / 10) * 10 * 100 - 10


def typical_cents(spec: RuleSpec, days_ago: float, rng: random.Random, phase: float) -> int:
    """Price drifting down towards today, with a slow wave and per-post noise."""
    drift = 1 - spec.trend * (1 - days_ago / HISTORY_DAYS)
    wave = 1 + 0.035 * math.sin(days_ago / 9 + phase)
    noise = 1 + rng.uniform(-0.035, 0.035)
    return round_price_cents(spec.base_reais * drift * wave * noise)


def build_text(
    spec: RuleSpec,
    *,
    title: str,
    cents: int,
    variant: str,
    store: str,
    serial: int,
    rng_value: float,
) -> tuple[str, str]:
    """(message text, link). `variant` is single | cashcard | coupon."""
    link = f"https://example.com/oferta/{spec.key}-{serial}"
    head = f"🔥 {title}"
    if variant == "cashcard":
        card = round(cents * (1.06 + 0.05 * rng_value) / 100) * 100
        body = f"💰 {format_price_cents(cents)} à vista\n💳 {format_price_cents(card)} no cartão"
    elif variant == "coupon":
        off = max(10, int(cents / 100 * (0.005 + 0.01 * rng_value)) // 10 * 10)
        body = f"💰 {format_price_cents(cents)}\n🎟️ Cupom EXEMPLO{off}: R$ {off} OFF"
    else:
        body = f"💰 {format_price_cents(cents)}\n🚚 Frete grátis"
    # The link right after the title keeps the product identity (everything before
    # the first link) free of price and store wording, like a real promo post.
    return f"{head}\n{link}\n{body}\n🏬 {store}", link


def message_for(
    spec: RuleSpec, cents: int, rng: random.Random, serial: int, *, variant: str | None = None
) -> tuple[str, str]:
    chosen = variant or rng.choices(("single", "cashcard", "coupon"), weights=(45, 40, 15))[0]
    return build_text(
        spec,
        title=rng.choice(spec.titles),
        cents=cents,
        variant=chosen,
        store=rng.choice(STORES),
        serial=serial,
        rng_value=rng.random(),
    )


# --- event plan ---------------------------------------------------------------


@dataclass
class Event:
    when: datetime
    spec: RuleSpec
    source_index: int
    text: str
    link: str
    cents: int


def _scripted(now: datetime) -> list[tuple[str, timedelta, int, str | None]]:
    """(rule key, age, price in cents, variant): the deals the demo story needs."""
    h, d = timedelta(hours=1), timedelta(days=1)
    return [
        # Live target hits (pinned "Alvo atingido") and near misses, last 24 h.
        ("rtx", 3 * h + timedelta(minutes=50), 1_629_900, "cashcard"),
        ("rtx", 5 * h + timedelta(minutes=35), 1_734_900, "single"),
        ("notebook", 9 * h + timedelta(minutes=12), 369_900, "cashcard"),
        ("notebook", 20 * h + timedelta(minutes=5), 399_900, "coupon"),
        ("fone", 1 * h + timedelta(minutes=40), 24_990, "single"),
        ("ssd", 14 * h + timedelta(minutes=20), 42_990, "cashcard"),
        # Older target hits: no longer pinned.
        ("ssd", 12 * d + 2 * h, 33_990, "cashcard"),
        ("rtx", 27 * d + 5 * h, 1_639_000, "cashcard"),
        ("fone", 31 * d + 3 * h, 18_990, "single"),
        ("notebook", 52 * d + 8 * h, 372_900, "single"),
        # Bait prices (far below 20% of the rule's median): the UI's outlier
        # floor must ignore them for "menor preço".
        ("rtx", 48 * d + 4 * h, 149_900, "single"),
        ("ssd", 2 * d + 11 * h, 2_990, "single"),
        ("monitor", 20 * d + 6 * h, 9_900, "single"),
        # Last priced post of the paused rule, just before it was paused.
        ("monitor", PAUSED_RULE_DAYS_AGO * d + 5 * h, 129_900, "single"),
    ]


def plan_events(now: datetime, rng: random.Random) -> list[Event]:
    events: list[Event] = []
    serial = 0
    phases = {spec.key: rng.uniform(0, 6.28) for spec in RULE_SPECS}

    def add(spec: RuleSpec, when: datetime, cents: int, variant: str | None, repost: bool) -> None:
        nonlocal serial
        serial += 1
        source_index = rng.randrange(len(SOURCE_NAMES))
        text, link = message_for(spec, cents, rng, serial, variant=variant)
        events.append(Event(when, spec, source_index, text, link, cents))
        if repost:
            delay = timedelta(minutes=rng.randint(2, 12), seconds=rng.randint(0, 59))
            if when + delay < now - timedelta(minutes=1):
                serial += 1
                other = (source_index + rng.randrange(1, len(SOURCE_NAMES))) % len(SOURCE_NAMES)
                # Same price, different group and store wording: a duplicate to group.
                text2, link2 = message_for(spec, cents, rng, serial, variant=variant)
                events.append(Event(when + delay, spec, other, text2, link2, cents))

    for key, age, cents, variant in _scripted(now):
        add(
            SPEC_BY_KEY[key],
            (now - age).replace(microsecond=0),
            cents,
            variant,
            repost=key == "rtx" and age < timedelta(days=1),
        )

    for spec in RULE_SPECS:
        newest = timedelta(days=PAUSED_RULE_DAYS_AGO + 1) if not spec.active else timedelta(hours=1)
        span = timedelta(days=HISTORY_DAYS - 2) - newest
        for _ in range(spec.random_events):
            # Denser towards today, like a feed that has been running a while.
            age = newest + span * (rng.random() ** 1.5)
            cents = typical_cents(spec, age.total_seconds() / 86_400, rng, phases[spec.key])
            # Random posts never reach the target: target hits are the scripted ones.
            cents = max(cents, round_price_cents(spec.target_reais * 1.05))
            add(spec, (now - age).replace(microsecond=0), cents, None, repost=rng.random() < 0.3)
    return events


# --- database writes ----------------------------------------------------------


def _has_other_data(session: Session) -> bool:
    return any(
        session.scalar(select(model.id).limit(1)) is not None
        for model in (Rule, Match, Admin, Source, Recipient)
    )


def is_seeded(session: Session) -> bool:
    chat_ids = list(session.scalars(select(Source.telegram_chat_id)))
    return bool(chat_ids) and all(is_demo_chat_id(chat_id) for chat_id in chat_ids)


class UnsafeDatabaseError(RuntimeError):
    """The target database holds data that is not demo data."""


def check_seedable(session: Session, *, force: bool) -> bool:
    """True when seeding should run, False when the demo data is already there.

    Always refuses a database with a source or recipient lacking the demo marker
    (`--force` does not override that: it exists to re-seed demo data, never to
    wipe a real database). Other leftovers (rules, matches, an admin) need `--force`.
    """
    chat_ids = [
        *session.scalars(select(Source.telegram_chat_id)),
        *session.scalars(select(Recipient.telegram_chat_id)),
    ]
    if any(not is_demo_chat_id(chat_id) for chat_id in chat_ids):
        raise UnsafeDatabaseError(
            "o banco tem fonte/destinatário sem o marcador 'demo:'; recuso semear por cima "
            "(nem com --force)."
        )
    if not _has_other_data(session):
        return True
    if is_seeded(session):
        return force
    if force:
        return True
    raise UnsafeDatabaseError("o banco já tem dados que não são de demonstração; use --force.")


def wipe_database(session: Session) -> None:
    for table in reversed(Base.metadata.sorted_tables):
        session.execute(table.delete())
    session.commit()


def _create_base_rows(session: Session, now: datetime) -> tuple[list[Source], list[Recipient]]:
    created = now - timedelta(days=CREATED_DAYS_AGO)
    sources = []
    for index, name in enumerate(SOURCE_NAMES, start=1):
        source = source_repo.create_source(
            session, name=name, telegram_chat_id=f"{DEMO_CHAT_PREFIX}group-{index}"
        )
        source.created_at = created
        sources.append(source)
    recipients = []
    for index, name in enumerate(RECIPIENT_NAMES, start=1):
        recipient = recipient_repo.create_recipient(
            session,
            name=name,
            telegram_chat_id=f"{DEMO_CHAT_PREFIX}recipient-{index}",
            allowlisted=True,
        )
        recipient.created_at = created
        recipients.append(recipient)
    session.add(Admin(password_hash=hash_password(DEMO_PASSWORD), created_at=created))
    for spec in RULE_SPECS:
        rule = rule_repo.create_rule(
            session,
            name=spec.name,
            include_terms=spec.include_terms,
            exclude_terms=spec.exclude_terms,
            max_price_cents=spec.ceiling_reais * 100,
            target_price_cents=spec.target_reais * 100,
        )
        rule.created_at = created
    session.commit()
    return sources, recipients


async def _feed_pipeline(session_factory: sessionmaker[Session], events: list[Event]) -> None:
    notifier = DemoNotifier()
    dedupe = DedupeCache()
    with session_factory() as session:
        source_ids = [s.id for s in session.scalars(select(Source).order_by(Source.id))]
        rule_ids = {r.name: r.id for r in session.scalars(select(Rule))}
    next_message_id = {source_id: 5_000 for source_id in source_ids}

    for event in sorted(events, key=lambda e: e.when):
        source_id = source_ids[event.source_index]
        next_message_id[source_id] += 1
        with session_factory() as session:
            rule = session.get(Rule, rule_ids[event.spec.name])
            assert rule is not None
            recipients = list(
                session.scalars(select(Recipient).where(Recipient.allowlisted.is_(True)))
            )
            await process_message(
                session,
                IncomingMessage(
                    source_id=source_id,
                    message_id=next_message_id[source_id],
                    text=event.text,
                    link=event.link,
                    received_at=event.when,
                ),
                rule,
                recipients,
                notifier,
                dedupe,
            )
            session.commit()


def _finish(session: Session, now: datetime, rng: random.Random) -> None:
    """Everything the pipeline cannot know after the fact."""
    matches = list(session.scalars(select(Match).order_by(Match.id)))
    by_id = {match.id: match for match in matches}
    for match in matches:
        match.created_at = match.matched_at
    deliveries = list(session.scalars(select(Delivery).order_by(Delivery.id)))
    for delivery in deliveries:
        matched_at = ensure_utc(by_id[delivery.match_id].matched_at)
        delivery.created_at = matched_at + timedelta(seconds=1)
        if delivery.status == "sent":
            delivery.delivered_at = matched_at + timedelta(seconds=rng.randint(1, 4))

    aged = [m for m in matches if now - ensure_utc(m.matched_at) > timedelta(days=1)]
    plain = {d.match_id: d for d in deliveries if d.kind == "immediate" and d.status == "sent"}
    # Failed sends to the secondary recipient (a Bot API hiccup), a few days ago.
    secondary = session.scalars(select(Recipient).order_by(Recipient.id).offset(1)).first()
    assert secondary is not None
    failed_candidates = [
        d
        for d in deliveries
        if d.recipient_id == secondary.id
        and d.kind == "immediate"
        and d.status == "sent"
        and timedelta(days=2) < now - ensure_utc(by_id[d.match_id].matched_at) < timedelta(days=12)
    ]
    failed = rng.sample(failed_candidates, k=min(3, len(failed_candidates)))
    failed_sources: list[int] = []
    for delivery in failed:
        delivery.status = "failed"
        delivery.delivered_at = None
        failed_sources.append(by_id[delivery.match_id].source_id)

    # The first listener boot scanned the last 15 days without alerting.
    historical_pool = [
        m
        for m in aged
        if timedelta(days=13) < now - ensure_utc(m.matched_at) < timedelta(days=15)
        and m.id in plain
    ]
    for match in historical_pool[:4]:
        for delivery in deliveries:
            if delivery.match_id == match.id and delivery.status == "sent":
                delivery.status = "historical"
                delivery.delivered_at = None

    # A few common matches went out in the daily digest instead.
    digest_pool = [
        m
        for m in aged
        if timedelta(days=3) < now - ensure_utc(m.matched_at) < timedelta(days=8)
        and m.id in plain
        and not any(d.match_id == m.id and d.id in {f.id for f in failed} for d in deliveries)
    ]
    for match in rng.sample(digest_pool, k=min(6, len(digest_pool))):
        sent_at = (ensure_utc(match.matched_at) + timedelta(days=1)).replace(
            hour=12, minute=0, second=0
        )
        for delivery in deliveries:
            if delivery.match_id == match.id and delivery.status == "sent":
                delivery.kind = "digest"
                delivery.delivered_at = sent_at
    session.flush()

    _write_counters(session, now, rng, failed_sources)

    session.add(
        DigestSettings(
            id=DIGEST_SETTINGS_ID,
            enabled=True,
            send_at_local="09:00",
            top_n=5,
            mute_individual=False,
            updated_at=now - timedelta(days=20),
        )
    )
    paused = next(spec for spec in RULE_SPECS if not spec.active)
    for rule in session.scalars(select(Rule)):
        if rule.name == paused.name:
            rule.active = False
    fone = session.scalar(select(Rule).where(Rule.name == SPEC_BY_KEY["fone"].name))
    assert fone is not None
    session.add(
        Snooze(
            scope="rule",
            rule_id=fone.id,
            until=now + timedelta(hours=5, minutes=20),
            created_at=now - timedelta(minutes=40),
        )
    )
    for cursor in session.scalars(select(ProcessingCursor)):
        last = session.scalar(
            select(Match.matched_at)
            .where(Match.source_id == cursor.source_id)
            .order_by(Match.matched_at.desc())
            .limit(1)
        )
        cursor.updated_at = last or now
    session.flush()

    config_hash = current_fingerprint(session)
    session.add(
        ListenerControl(
            id=LISTENER_CONTROL_ID,
            state="idle",
            reload_requested_at=now - timedelta(days=2, hours=3, minutes=1),
            reload_applied_at=now - timedelta(days=2, hours=3),
            last_sources_loaded=len(SOURCE_NAMES),
            last_rules_loaded=sum(1 for spec in RULE_SPECS if spec.active),
            last_recipients_loaded=len(RECIPIENT_NAMES),
            last_new_matches=4,
            last_scan_failures=0,
            applied_config_hash=config_hash,
            listener_seen_at=now,
            updated_at=now,
        )
    )
    _seed_purchases(session, now)
    session.commit()


# S19-04: fictional purchases for the Economia screen. (rule key, days before `now`, price as a
# fraction of the 90-day median the app had seen by then, name). One is above the median on
# purpose: the report shows an overpayment honestly.
PURCHASE_SCRIPT: tuple[tuple[str, int, float, str, str | None], ...] = (
    ("rtx", 41, 0.93, "Placa de vídeo RTX 5090 (exemplo)", "Loja Exemplo"),
    ("monitor", 27, 0.91, "Monitor 27 polegadas (exemplo)", "MegaStore Demo"),
    ("ssd", 19, 1.06, "SSD NVMe 2 TB (exemplo)", "Tech Fictícia"),
    ("fone", 11, 0.88, "Fone bluetooth (exemplo)", None),
)
UNLINKED_PURCHASES: tuple[tuple[int, int, str, str | None], ...] = (
    (33, 4_990, "Cabo HDMI 2.1 (exemplo)", "Mercado Demo"),
)


def _seed_purchases(session: Session, now: datetime) -> None:
    """Fictional purchases linked to seeded products, priced from the seeded history itself."""
    rules = {rule.name: rule for rule in session.scalars(select(Rule))}
    for key, days_ago, fraction, name, store in PURCHASE_SCRIPT:
        spec = next(candidate for candidate in RULE_SPECS if candidate.key == key)
        rule = rules.get(spec.name)
        if rule is None:
            continue
        purchased_at = now - timedelta(days=days_ago)
        rows = session.execute(
            select(Match.product_key, Match.price_cents, Match.matched_at).where(
                Match.rule_id == rule.id,
                Match.product_key.is_not(None),
                Match.price_cents.is_not(None),
            )
        ).all()
        known = [Observation(at=ensure_utc(at), price_cents=int(price)) for _, price, at in rows]
        prior = [
            o.price_cents
            for o in known
            if purchased_at - timedelta(days=90) <= o.at <= purchased_at
        ]
        reference = median(prior)
        if reference is None:
            continue
        counts: dict[str, int] = {}
        for product_key, _, _ in rows:
            counts[product_key] = counts.get(product_key, 0) + 1
        product_key = min(counts, key=lambda candidate: (-counts[candidate], candidate))
        session.add(
            Purchase(
                name=name,
                price_cents=round_price_cents(reference * fraction / 100),
                purchased_at=purchased_at,
                store=store,
                product_key=product_key,
                created_at=purchased_at,
            )
        )
    for days_ago, cents, name, store in UNLINKED_PURCHASES:
        purchased_at = now - timedelta(days=days_ago)
        session.add(
            Purchase(
                name=name,
                price_cents=cents,
                purchased_at=purchased_at,
                store=store,
                created_at=purchased_at,
            )
        )


def _write_counters(
    session: Session, now: datetime, rng: random.Random, failed_sources: list[int]
) -> None:
    """Aggregate counters for traffic that never matched (its text is not kept)."""
    existing = {(c.source_id, c.reason): c for c in session.scalars(select(MetricCounter))}
    source_ids = [s.id for s in session.scalars(select(Source).order_by(Source.id))]
    for source_id in source_ids:
        for reason, low, high in (
            (MetricReason.NO_TERM, 2_400, 6_800),
            (MetricReason.BLOCKED, 40, 190),
            (MetricReason.PRICE_ABOVE_CEILING, 12, 70),
        ):
            counter = MetricCounter(
                source_id=source_id, reason=reason.value, count=rng.randint(low, high)
            )
            session.add(counter)
            existing[(source_id, reason.value)] = counter
    for source_id in failed_sources:
        key = (source_id, MetricReason.DELIVERY_FAILURE.value)
        failure_counter = existing.get(key)
        if failure_counter is None:
            failure_counter = MetricCounter(source_id=source_id, reason=key[1], count=0)
            session.add(failure_counter)
            existing[key] = failure_counter
        failure_counter.count += 1
    session.flush()
    for index, counter in enumerate(
        sorted(existing.values(), key=lambda c: (c.source_id or 0, c.reason))
    ):
        stamp = now - timedelta(minutes=2 + index * 7 % 53)
        session.execute(
            update(MetricCounter).where(MetricCounter.id == counter.id).values(updated_at=stamp)
        )


@dataclass(frozen=True)
class SeedSummary:
    seeded: bool
    sources: int
    rules: int
    matches: int
    deliveries: int


def summarize(session: Session) -> SeedSummary:
    return SeedSummary(
        seeded=is_seeded(session),
        sources=len(list(session.scalars(select(Source.id)))),
        rules=len(list(session.scalars(select(Rule.id)))),
        matches=len(list(session.scalars(select(Match.id)))),
        deliveries=len(list(session.scalars(select(Delivery.id)))),
    )


def seed_demo_database(
    session_factory: sessionmaker[Session],
    *,
    now: datetime | None = None,
    force: bool = False,
) -> SeedSummary:
    """Seed `session_factory`'s database (schema must already exist). Idempotent."""
    moment = (now or datetime.now(UTC)).replace(microsecond=0)
    with session_factory() as session:
        if not check_seedable(session, force=force):
            return summarize(session)
        wipe_database(session)
        _create_base_rows(session, moment)

    rng = random.Random(SEED)
    events = plan_events(moment, rng)
    asyncio.run(_feed_pipeline(session_factory, events))
    with session_factory() as session:
        _finish(session, moment, random.Random(SEED + 1))
        return summarize(session)


# --- live replay --------------------------------------------------------------

CONTENT_TABLES: tuple[tuple[Any, tuple[str, ...]], ...] = (
    (Source, ("id", "name", "telegram_chat_id", "active", "created_at")),
    (Recipient, ("id", "name", "telegram_chat_id", "allowlisted", "active", "created_at")),
    (
        Rule,
        (
            "id",
            "name",
            "include_terms",
            "exclude_terms",
            "max_price_cents",
            "target_price_cents",
            "active",
            "created_at",
        ),
    ),
    (
        Match,
        (
            "id",
            "source_id",
            "rule_id",
            "telegram_message_id",
            "message_text",
            "price_cents",
            "price_cash_cents",
            "price_card_cents",
            "message_link",
            "product_key",
            "matched_at",
            "created_at",
        ),
    ),
    (
        Delivery,
        ("id", "match_id", "recipient_id", "status", "kind", "delivered_at", "created_at"),
    ),
    (Snooze, ("id", "scope", "rule_id", "until", "created_at")),
    (MetricCounter, ("id", "source_id", "reason", "count", "updated_at")),
    (
        ListenerControl,
        (
            "id",
            "state",
            "reload_applied_at",
            "last_sources_loaded",
            "last_rules_loaded",
            "last_recipients_loaded",
            "last_new_matches",
            "applied_config_hash",
        ),
    ),
    (DigestSettings, ("id", "enabled", "send_at_local", "top_n", "mute_individual")),
)


def content_hash(session: Session) -> str:
    """Stable digest of the demo content (admin password hash is salted: excluded)."""
    digest = hashlib.sha256()
    for model, columns in CONTENT_TABLES:
        rows = session.execute(select(*(getattr(model, c) for c in columns)).order_by(model.id))
        for row in rows:
            digest.update(json.dumps([str(v) for v in row], ensure_ascii=False).encode())
    return digest.hexdigest()


class DemoReplayer:
    """Inserts one fictional match per `tick` so the live feed visibly moves.

    Goes through the same pipeline and no-op notifier as the seed, so the SSE
    watcher publishes it like any other match. Only rules that are active are
    used, and prices stay above the rule's target (a live "alvo atingido" is
    left to the seeded story).
    """

    def __init__(
        self,
        session_factory: sessionmaker[Session],
        *,
        rng: random.Random | None = None,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self._session_factory = session_factory
        self._rng = rng or random.Random()
        self._clock = clock
        self._notifier = DemoNotifier()
        self._dedupe = DedupeCache()
        self._serial = int(self._clock().timestamp())

    def next_delay_seconds(self) -> float:
        return self._rng.uniform(20, 40)

    async def tick(self) -> int | None:
        """Insert one match; returns its id (None if it was discarded)."""
        now = self._clock()
        specs = [spec for spec in RULE_SPECS if spec.active]
        spec = self._rng.choice(specs)
        cents = typical_cents(spec, 0, self._rng, 0.0)
        cents = max(cents, round_price_cents(spec.target_reais * 1.05))
        self._serial += 1
        text, link = message_for(spec, cents, self._rng, self._serial)
        with self._session_factory() as session:
            rule = session.scalar(select(Rule).where(Rule.name == spec.name, Rule.active.is_(True)))
            sources = list(session.scalars(select(Source).where(Source.active.is_(True))))
            recipients = list(
                session.scalars(
                    select(Recipient).where(
                        Recipient.active.is_(True), Recipient.allowlisted.is_(True)
                    )
                )
            )
            if rule is None or not sources:
                return None
            source = self._rng.choice(sources)
            result = await process_message(
                session,
                IncomingMessage(
                    source_id=source.id,
                    message_id=self._serial,
                    text=text,
                    link=link,
                    received_at=now,
                ),
                rule,
                recipients,
                self._notifier,
                self._dedupe,
            )
            session.commit()
            return result.match.id if result.match is not None else None
