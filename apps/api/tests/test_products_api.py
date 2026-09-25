"""S14-01: `GET /products/{key}` and the product fields of `GET /matches`.

The clock is pinned through the `utc_now` dependency; every title is invented.
"""

import itertools
import time
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, create_engine, event
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.main import app
from app.pipeline import evaluate_rule
from app.product_history import get_display_timezone
from app.utc import utc_now
from auth.hashing import hash_password
from auth.rate_limit import LoginRateLimiter
from auth.session import SessionStore
from models import Admin, Match, Rule, Source
from models.base import Base
from packages.rules.product import product_key
from packages.telegram.adapter import TelegramAdapter
from packages.telegram.fakes import FakeTelegramClient

PASSWORD = "correct horse battery staple"
NOW = datetime(2026, 9, 23, 15, 0, tzinfo=UTC)
PALIT = "Placa de Vídeo Palit RTX 5070 Ti 16GB"
PALIT_KEY = "palit-rtx-5070-ti"  # S14-01 recalibration: model fingerprint, not the full title
GIGABYTE = "Placa de Vídeo Gigabyte RTX 5070 Ti Windforce 16GB"


@dataclass
class ApiContext:
    client: TestClient
    engine: Engine
    session_factory: sessionmaker[Session]
    ids: dict[str, int] = field(default_factory=dict)


async def _no_sleep(delay: float) -> None:
    return None


@pytest.fixture
def api() -> Iterator[ApiContext]:
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    test_sessionmaker = sessionmaker(bind=engine, expire_on_commit=False)
    with test_sessionmaker() as setup_session:
        setup_session.add(Admin(password_hash=hash_password(PASSWORD)))
        source_a = Source(name="Grupo A", telegram_chat_id="-1001")
        source_b = Source(name="Grupo B", telegram_chat_id="-1002")
        rule = Rule(name="Placas", include_terms="rtx")
        setup_session.add_all([source_a, source_b, rule])
        setup_session.commit()
        ids = {"a": source_a.id, "b": source_b.id, "rule": rule.id}

    state_names = (
        "session_factory",
        "session_store",
        "rate_limiter",
        "started_at",
        "telegram_adapter",
        "bot_configured",
        "notification_test_ids",
    )
    previous_state = {name: getattr(app.state, name) for name in state_names}
    previous_overrides = app.dependency_overrides.copy()
    try:
        app.state.session_factory = test_sessionmaker
        app.state.session_store = SessionStore()
        app.state.rate_limiter = LoginRateLimiter()
        app.state.started_at = time.monotonic() - 5.0
        app.state.telegram_adapter = TelegramAdapter(
            api_id=None, api_hash=None, client=FakeTelegramClient(), sleep=_no_sleep
        )
        app.state.bot_configured = False
        app.state.notification_test_ids = itertools.count(start=-1, step=-1)
        app.dependency_overrides.clear()
        app.dependency_overrides[utc_now] = lambda: NOW
        app.dependency_overrides[get_display_timezone] = lambda: ZoneInfo("America/Sao_Paulo")
        with TestClient(app, base_url="https://testserver") as client:
            response = client.post("/auth/login", json={"password": PASSWORD})
            assert response.status_code == 200
            yield ApiContext(
                client=client, engine=engine, session_factory=test_sessionmaker, ids=ids
            )
    finally:
        app.dependency_overrides.clear()
        app.dependency_overrides.update(previous_overrides)
        for name, value in previous_state.items():
            setattr(app.state, name, value)
        engine.dispose()


def _add(
    api: ApiContext,
    title: str,
    *,
    ago: timedelta,
    price_cents: int | None,
    source: str = "a",
    link: str | None = None,
) -> int:
    price = "Preço no link"
    if price_cents is not None:
        price = f"R$ {price_cents / 100:.2f} no pix".replace(".", ",")
    text = f"🔥 {title}\n\n💵 {price}\nhttps://loja.example/p"
    with api.session_factory() as session:
        match = Match(
            source_id=api.ids[source],
            rule_id=api.ids["rule"],
            message_text=text,
            price_cents=price_cents,
            message_link=link,
            matched_at=NOW - ago,
            product_key=product_key(text),
        )
        session.add(match)
        session.commit()
        return match.id


def _add_raw(api: ApiContext, message_text: str, *, ago: timedelta, source: str = "a") -> int:
    """Like `_add`, but for a test that needs the exact message text on the
    row — no title/price template wrapped around it — so `product_key`
    computes on precisely the same string a real `Match` would carry.
    """
    with api.session_factory() as session:
        match = Match(
            source_id=api.ids[source],
            rule_id=api.ids["rule"],
            message_text=message_text,
            price_cents=None,
            matched_at=NOW - ago,
            product_key=product_key(message_text),
        )
        session.add(match)
        session.commit()
        return match.id


def test_product_history_aggregates_every_posting_of_the_key(api: ApiContext) -> None:
    oldest = _add(api, PALIT, ago=timedelta(days=120), price_cents=4_999_00)  # outside 90d
    _add(api, PALIT, ago=timedelta(days=60), price_cents=6_200_00, source="b")
    _add(api, PALIT.upper(), ago=timedelta(days=20), price_cents=5_900_00)
    _add(api, PALIT, ago=timedelta(days=5), price_cents=5_500_00, source="b")
    _add(api, PALIT, ago=timedelta(days=2), price_cents=None)  # counts, never plotted
    newest = _add(api, PALIT, ago=timedelta(hours=1), price_cents=5_749_00, link="https://t.me/g/9")
    _add(api, GIGABYTE, ago=timedelta(days=1), price_cents=100_00)  # another product

    response = api.client.get(f"/products/{PALIT_KEY}")

    assert response.status_code == 200
    body = response.json()
    assert body["product_key"] == PALIT_KEY
    assert body["title"] == PALIT
    assert body["total_count"] == 6
    assert body["sources"] == [
        {"id": api.ids["a"], "name": "Grupo A"},
        {"id": api.ids["b"], "name": "Grupo B"},
    ]
    assert body["first_seen_at"] == "2026-05-26T15:00:00Z"
    assert body["current_price_cents"] == 5_749_00
    assert body["current_price_at"] == "2026-09-23T14:00:00Z"
    assert body["lowest_90d_cents"] == 5_500_00
    assert body["highest_90d_cents"] == 6_200_00
    # 30 days: 5.900, 5.500 and 5.749 (the price-less posting is not a zero).
    assert body["average_30d_cents"] == round((5_900_00 + 5_500_00 + 5_749_00) / 3)
    assert body["range"] == "90d"
    assert [point["price_cents"] for point in body["series"]] == [
        6_200_00,
        5_900_00,
        5_500_00,
        5_749_00,
    ]
    postings = body["postings"]
    assert len(postings) == 6
    assert postings[0] == {
        "id": newest,
        "source_id": api.ids["a"],
        "source_name": "Grupo A",
        "price_cents": 5_749_00,
        "matched_at": "2026-09-23T14:00:00Z",
        "message_link": "https://t.me/g/9",
    }
    assert postings[-1]["id"] == oldest
    assert postings[1]["price_cents"] is None


@pytest.mark.parametrize(
    ("history_range", "expected"),
    [
        ("90d", [6_200_00, 5_900_00, 5_500_00]),
        ("30d", [5_900_00, 5_500_00]),
        ("7d", [5_500_00]),
    ],
)
def test_series_follows_the_requested_window(
    api: ApiContext, history_range: str, expected: list[int]
) -> None:
    _add(api, PALIT, ago=timedelta(days=60), price_cents=6_200_00)
    _add(api, PALIT, ago=timedelta(days=20), price_cents=5_900_00)
    _add(api, PALIT, ago=timedelta(days=5), price_cents=5_500_00)

    body = api.client.get(f"/products/{PALIT_KEY}", params={"range": history_range}).json()

    assert body["range"] == history_range
    assert [point["price_cents"] for point in body["series"]] == expected
    # The statistics keep their own fixed windows whatever the chart shows.
    assert body["lowest_90d_cents"] == 5_500_00
    assert body["highest_90d_cents"] == 6_200_00


def test_series_keeps_the_lowest_price_of_each_local_day(api: ApiContext) -> None:
    # 01:00 UTC on the 21st is still the 20th in São Paulo (UTC-3).
    _add(api, PALIT, ago=NOW - datetime(2026, 9, 20, 13, 0, tzinfo=UTC), price_cents=5_800_00)
    _add(api, PALIT, ago=NOW - datetime(2026, 9, 21, 1, 0, tzinfo=UTC), price_cents=5_600_00)
    _add(api, PALIT, ago=NOW - datetime(2026, 9, 21, 12, 0, tzinfo=UTC), price_cents=5_700_00)

    body = api.client.get(f"/products/{PALIT_KEY}").json()

    assert body["series"] == [
        {"date": "2026-09-20", "price_cents": 5_600_00},
        {"date": "2026-09-21", "price_cents": 5_700_00},
    ]


def test_a_product_without_any_price_has_postings_but_no_series(api: ApiContext) -> None:
    _add(api, PALIT, ago=timedelta(days=1), price_cents=None)

    body = api.client.get(f"/products/{PALIT_KEY}").json()

    assert body["total_count"] == 1
    assert body["series"] == []
    assert body["current_price_cents"] is None
    assert body["current_price_at"] is None
    assert body["lowest_90d_cents"] is None
    assert body["average_30d_cents"] is None
    assert body["highest_90d_cents"] is None


def test_rule_suggestion_uses_real_history_and_a_conservative_fingerprint(api: ApiContext) -> None:
    _add(api, PALIT, ago=timedelta(days=60), price_cents=5_400_00)
    _add(api, PALIT, ago=timedelta(days=20), price_cents=6_000_00)
    _add(api, PALIT, ago=timedelta(days=5), price_cents=5_500_00)
    _add(api, PALIT, ago=timedelta(days=1), price_cents=None)

    response = api.client.get(f"/products/{PALIT_KEY}/rule-suggestion")

    assert response.status_code == 200
    assert response.json() == {
        "product_key": PALIT_KEY,
        "name": PALIT,
        # Shortest literal, contiguous phrase of the real title that still
        # anchors on the model-code token ("5070") — not `product_key`
        # itself (`palit-rtx-5070-ti`, brand-first and reordered), which
        # would never appear verbatim in "...Palit RTX 5070 Ti..." and so
        # would never actually match a real posting of this product.
        "include_terms": "rtx 5070",
        "average_30d_cents": 5_750_00,
        # 575_000 * 97 / 100 = 557_750 exactly; integer half-up is documented.
        "max_price_cents": 5_577_50,
        "lowest_90d_cents": 5_400_00,
        "target_price_cents": 5_400_00,
    }


def test_rule_suggestion_is_honestly_null_without_priced_history(api: ApiContext) -> None:
    _add(api, PALIT, ago=timedelta(days=1), price_cents=None)

    body = api.client.get(f"/products/{PALIT_KEY}/rule-suggestion").json()

    assert body["average_30d_cents"] is None
    assert body["max_price_cents"] is None
    assert body["lowest_90d_cents"] is None
    assert body["target_price_cents"] is None


def test_rule_suggestion_requires_auth_and_returns_404_for_an_unknown_product(
    api: ApiContext,
) -> None:
    assert api.client.get("/products/unknown/rule-suggestion").status_code == 404

    api.client.post("/auth/logout")
    api.client.cookies.clear()
    assert api.client.get(f"/products/{PALIT_KEY}/rule-suggestion").status_code == 401


# S14-09 review (PR #102): `_suggest_include_terms` used to be one OR-term
# built from `product_key` — brand-first, deduped, reordered from the real
# title. That is perfect for a *stable identity* and wrong for a *rule
# term*, which has to appear verbatim in the message it is meant to catch.
# Every title below is a real failure the review measured: the suggested
# term never matched the product it was suggested for.
RULE_SUGGESTION_REGRESSION_TITLES = [
    'Cadeira Gamer DT3 Spider-Man™ Edição Especial\n\nR$ 1.299,00',
    "Memória RAM 8GB DDR5 4800MHz Gamer Memtech\n\nR$ 219,00\nhttps://x.example/7",
    "MEMORIA RAM 8GB DDR5 4800MHZ GAMER MEMTECH PARA DESKTOP\n\nR$ 199,90 no pix\nhttps://x.example/8",
    "Memória Kingston Fury Beast 16GB DDR5 5600MHz\n\nR$ 459,00",
]


@pytest.mark.parametrize("message_text", RULE_SUGGESTION_REGRESSION_TITLES)
def test_rule_suggestion_include_terms_matches_the_real_message_it_was_built_from(
    api: ApiContext, message_text: str
) -> None:
    key = product_key(message_text)
    assert key is not None, "fixture must itself carry a product_key"
    _add_raw(api, message_text, ago=timedelta(days=1))

    body = api.client.get(f"/products/{key}/rule-suggestion").json()

    candidate_rule = Rule(
        include_terms=body["include_terms"], exclude_terms=None, max_price_cents=None
    )
    assert evaluate_rule(candidate_rule, message_text).discard_reason is None, (
        f"{body['include_terms']!r} does not match its own message: {message_text!r}"
    )


# Property test (S14-09 review): every literal message text in
# `packages/rules/tests/test_product.py` that carries a `product_key` — kept
# in sync by hand (cross-importing one test module's fixtures from another,
# without an `__init__.py` chain between `apps/api/tests` and
# `packages/rules/tests`, is fragile) — grouped by the *real* key several of
# them share on purpose (the whole point of those tests). For every such
# group, the suggested `include_terms` must match every message in it: no
# posting the suggestion was built from may be left uncovered.
_LITERAL_PRODUCT_MESSAGES = [
    # PALIT_VARIATIONS
    (
        "Placa de Vídeo Palit RTX 5070 Ti GamingPro 16GB\n\n"
        "💵 R$ 5.749,00 à vista no pix\n"
        "💳 ou 10x de R$ 639,00 sem juros\n\n"
        "https://loja.example/palit\n\nCupom, preço e estoque por tempo limitado."
    ),
    "🔥 PLACA DE VIDEO PALIT RTX 5070 TI GAMINGPRO 16GB 🔥\n\nR$ 5.499 no pix\nhttps://x.example/1",
    "Placa de Vídeo Palit RTX 5070 Ti GamingPro 16GB por R$ 5.899,90\nhttps://x.example/2",
    (
        "⚡️ OFERTA RELÂMPAGO ⚡️\n"
        "Placa de Vídeo Palit RTX 5070 Ti GamingPro 16GB\n\n"
        "🎟 Cupom: GPU150\n🚚 Frete grátis\n5.749,00 no boleto\nhttps://x.example/3"
    ),
    "Baixou! Placa de Vídeo Palit RTX 5070 Ti GamingPro 16GB - 12x R$ 499,00\nhttps://x.example/4",
    "Placa de Vídeo Palit RTX 5070 Ti GamingPro 16GB\n\n💰 5.749,00\n👉 Compre aqui:",
    "Placa de Vídeo Palit RTX 5070 Ti GamingPro 16GB a partir de R$ 5.600\n15% OFF",
    (
        "Placa De Video Geforce Nvidia Palit RTX5070TI 16GB GamingPro-S GDDR7 256Bit 3 DP HD\n\n"
        "💰 R$ 5.799,00\n🎯 100-200002099XYZ\n🔗 Resgate todos os cupons\nhttps://x.example/5"
    ),
    (
        "Se o nome dele ja e insano imagine o desempenho\n"
        "Placa de Vídeo Palit RTX 5070 Ti GamingPro 16GB\n\n"
        "R$ 5.749,00 no pix\nhttps://x.example/6"
    ),
    # test_different_products_never_share_a_key (each message on its own —
    # the test only cares that pairs differ, every message still has a key)
    "Placa de Vídeo Palit RTX 5070 Ti GamingPro 16GB\n\nR$ 5.749,00",
    "Placa de Vídeo Gigabyte RTX 5070 Ti Windforce 16GB\n\nR$ 5.749,00",
    "Placa de Vídeo Palit RTX 5070 GamingPro 12GB\n\nR$ 3.999,00",
    "Placa de Vídeo Palit RTX 5070 Ti Infinity 16GB\n\nR$ 5.699,00",
    "Placa-mãe MSI PRO B840M-B AM5 DDR5 mATX\n\nR$ 599,00",
    "Placa-mãe MSI B840M Gaming Wifi DDR5 AM5 mATX\n\nR$ 749,00",
    "Placa-mãe ASRock B850M Challenger AM5 DDR5 mATX\n\nR$ 899,00",
    "Placa-mãe ASRock B850M Challenger Wifi White AM5 DDR5 mATX Branco\n\nR$ 949,00",
    "SSD Kingston NV3 1TB NVMe\n\nR$ 399,00",
    "SSD Kingston NV2 1TB NVMe\n\nR$ 349,00",
    "Placa-mãe MSI PRO B650M-A AM5 DDR5 mATX\n\nR$ 649,00",
    "Placa-mãe MSI PRO B650M-P AM5 DDR5 mATX\n\nR$ 679,00",
    # test_single_letter_suffix_is_kept_on_a_model_code_but_dropped_on_a_variant_word
    "Placa-mãe MSI PRO B840M-B AM5 DDR5 mATX\n\nR$ 599,00",
    "PLACA MAE MSI PRO B840M-B\n\nR$ 579,00\nhttps://x.example/9",
    (
        "Placa-mãe MSI PRO B840M-B AM5 DDR5 mATX M.2 NVMe HDMI VGA\n\n"
        "🎯 Resgate todos os\nhttps://x.example/10"
    ),
    "Placa de Vídeo Palit RTX 5070 Ti GamingPro-S 16GB\n\nR$ 5.799,00",
    # test_a_word_repeated_in_the_source_is_not_repeated_in_the_key
    (
        "Placa Mãe MSI Pro B840M-B, DDR5, Socket AMD AM5, M-ATX, "
        "Chipset AMD B840, PRO-B840M-B\n\nR$ 599,00"
    ),
    # RYZEN_VARIATIONS
    "Processador AMD Ryzen 7 9800X3D, 8 Núcleos, AM5\n\nR$ 2.899,00",
    (
        "Processador Amd Ryzen 7 9800X3D 4.7Ghz 5.2Ghz Max Turbo Cache 8 MB "
        "8 Nucleos 16 Threads Am5 Sem Video Integrado 100-200011084XOF\n\nR$ 2.799,00"
    ),
    (
        "Processador AMD Ryzen 7 9800X3D (AM5/ 8 Cores/ 16 Threads/ 5.2 GHz/ "
        "104Mb Cache/Radeon Graphics/Sem cooler\n\nR$ 2.849,00"
    ),
    "Processador Ryzen 7 9800X3D\n\nR$ 2.999,00",
    # test_a_brand_with_no_other_model_code_falls_back_to_capacity
    "Memória RAM 8GB DDR5 4800MHz Gamer Memtech\n\nR$ 219,00\nhttps://x.example/7",
    "MEMORIA RAM 8GB DDR5 4800MHZ GAMER MEMTECH PARA DESKTOP\n\nR$ 199,90 no pix\nhttps://x.example/8",
    "Memória RAM 16GB DDR5 4800MHz Gamer Memtech\n\nR$ 399,00",
    # test_products_with_no_recognised_brand_keep_their_digit_tokens
    'Monitor LG 27" 2x HDMI\n\nR$ 999,00',
    "Controle 8BitDo 4x4 Pro\nR$ 299",
    "Fone Soundcore 1.000mAh\nR$ 199,90",
    "Notebook Acer Nitro V15 RTX 4050\n\nR$ 4.999,00",
    # link handling
    "https://loja.example/p\nMouse Logitech G305\nR$ 199",
    "Mouse Logitech G305\nhttps://loja.example/p\nTeclado Redragon Kumara",
    # title/connector-word tests
    "🔥 Placa de Vídeo Palit RTX 5070 Ti 16GB 🔥\n\n💵 R$ 5.749,00 no pix\nhttps://x.example",
    "Placa de Vídeo Palit RTX 5070 Ti GamingPro 16GB por R$ 5.899,90\nhttps://x.example/2",
    "Barato A",
    # test_key_is_deterministic_and_url_safe
    "Cadeira Gamer DT3 Spider-Man™ Edição Especial\n\nR$ 1.299,00",
]


def test_rule_suggestion_covers_every_grouped_posting_for_every_literal_in_test_product(
    api: ApiContext,
) -> None:
    groups: dict[str, list[str]] = {}
    for message_text in _LITERAL_PRODUCT_MESSAGES:
        key = product_key(message_text)
        if key is None:
            continue
        groups.setdefault(key, []).append(message_text)

    assert len(groups) >= 20, "the literal corpus above must still carry real product_key groups"

    for key, messages in groups.items():
        for index, message_text in enumerate(messages):
            _add_raw(api, message_text, ago=timedelta(days=index + 1))

        body = api.client.get(f"/products/{key}/rule-suggestion").json()
        assert body["include_terms"], f"{key}: no include_terms suggested at all"
        terms = [term.strip() for term in body["include_terms"].split(",")]

        for message_text in messages:
            matched = any(
                evaluate_rule(
                    Rule(include_terms=term, exclude_terms=None, max_price_cents=None), message_text
                ).discard_reason
                is None
                for term in terms
            )
            assert matched, (
                f"key {key!r}: include_terms {body['include_terms']!r} "
                f"does not cover posting {message_text!r}"
            )


def test_unknown_product_is_404_and_invalid_range_is_422(api: ApiContext) -> None:
    _add(api, PALIT, ago=timedelta(days=1), price_cents=5_000_00)

    assert api.client.get("/products/nao-existe").status_code == 404
    assert api.client.get(f"/products/{PALIT_KEY}", params={"range": "1y"}).status_code == 422


def test_products_require_a_session(api: ApiContext) -> None:
    api.client.post("/auth/logout")
    api.client.cookies.clear()

    assert api.client.get(f"/products/{PALIT_KEY}").status_code == 401


def test_feed_items_carry_product_key_and_a_short_sparkline(api: ApiContext) -> None:
    for day in range(89, -1, -1):  # 90 priced days: downsampled to at most 30 points
        _add(api, PALIT, ago=timedelta(days=day, hours=1), price_cents=5_000_00 + day * 100)
    _add(api, PALIT, ago=timedelta(days=200), price_cents=1_00)  # outside 90d
    unpriced = _add(api, GIGABYTE, ago=timedelta(minutes=5), price_cents=None)

    items = {item["id"]: item for item in api.client.get("/matches").json()}

    gigabyte = items[unpriced]
    assert gigabyte["product_key"] == "gigabyte-rtx-5070-ti-windforce"
    assert gigabyte["sparkline"] == []
    palit_items = [item for item in items.values() if item["product_key"] == PALIT_KEY]
    sparkline = palit_items[0]["sparkline"]
    assert 1 < len(sparkline) <= 30
    assert [point["date"] for point in sparkline] == sorted(point["date"] for point in sparkline)
    assert min(point["price_cents"] for point in sparkline) == 5_000_00
    assert all(item["sparkline"] == sparkline for item in palit_items)


def _count_selects(api: ApiContext) -> int:
    statements: list[str] = []

    def _record(*args: object) -> None:
        statement = args[2]
        assert isinstance(statement, str)
        if statement.lstrip().upper().startswith("SELECT"):
            statements.append(statement)

    event.listen(api.engine, "before_cursor_execute", _record)
    try:
        assert api.client.get("/matches").status_code == 200
    finally:
        event.remove(api.engine, "before_cursor_execute", _record)
    return len(statements)


def test_feed_sparklines_do_not_add_a_query_per_item(api: ApiContext) -> None:
    _add(api, PALIT, ago=timedelta(days=3), price_cents=5_500_00)
    _add(api, GIGABYTE, ago=timedelta(days=3), price_cents=5_300_00)
    few = _count_selects(api)

    for index in range(12):
        _add(api, f"Produto de teste modelo {index}", ago=timedelta(days=index), price_cents=100_00)
    many = _count_selects(api)

    assert many == few


def test_a_message_matched_by_two_rules_is_one_posting(api: ApiContext) -> None:
    text = f"{PALIT}\n\nR$ 5.000,00 no pix"
    with api.session_factory() as session:
        other_rule = Rule(name="Placas Palit", include_terms="palit")
        session.add(other_rule)
        session.flush()
        for rule_id in (api.ids["rule"], other_rule.id):
            session.add(
                Match(
                    source_id=api.ids["a"],
                    rule_id=rule_id,
                    telegram_message_id=42,
                    message_text=text,
                    price_cents=5_000_00,
                    matched_at=NOW - timedelta(days=1),
                    product_key=product_key(text),
                )
            )
        session.commit()
    _add(api, PALIT, ago=timedelta(days=2), price_cents=6_000_00)

    body = api.client.get(f"/products/{PALIT_KEY}").json()

    assert body["total_count"] == 2
    assert [posting["price_cents"] for posting in body["postings"]] == [5_000_00, 6_000_00]
    assert body["average_30d_cents"] == 5_500_00
    (item,) = [i for i in api.client.get("/matches").json() if i["price_cents"] == 6_000_00]
    assert [point["price_cents"] for point in item["sparkline"]] == [6_000_00, 5_000_00]
