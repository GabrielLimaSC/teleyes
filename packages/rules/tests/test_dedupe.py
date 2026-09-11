from packages.rules.dedupe import DedupeCache, compute_signature, normalize_link


def test_signature_is_deterministic_for_identical_input() -> None:
    first = compute_signature(1, "Promoção iPhone 15", price_cents=399900)
    second = compute_signature(1, "Promoção iPhone 15", price_cents=399900)

    assert first == second


def test_signature_ignores_cosmetic_differences_reprocessing_same_message() -> None:
    original = compute_signature(1, "Promoção iPhone 15!!!", price_cents=399900)
    reprocessed = compute_signature(1, "PROMOÇÃO   iphone 15", price_cents=399900)

    assert original == reprocessed


def test_signature_differs_for_different_source_or_price() -> None:
    base = compute_signature(1, "Promoção iPhone 15", price_cents=399900)
    other_source = compute_signature(2, "Promoção iPhone 15", price_cents=399900)
    other_price = compute_signature(1, "Promoção iPhone 15", price_cents=379900)

    assert base != other_source
    assert base != other_price


def test_dedupe_cache_processes_a_signature_only_once() -> None:
    cache = DedupeCache()
    signature = compute_signature(1, "Promoção iPhone 15", price_cents=399900)

    assert cache.should_process(signature) is True
    assert cache.should_process(signature) is False
    assert cache.should_process(signature) is False


# --- link normalization -------------------------------------------------------


def test_normalize_link_strips_query_fragment_and_trailing_slash() -> None:
    tracked = normalize_link("https://loja.com/produto/123?utm_source=telegram&x=1")
    clean_with_slash = normalize_link("https://loja.com/produto/123/")

    assert tracked == "https://loja.com/produto/123"
    assert clean_with_slash == "https://loja.com/produto/123"


def test_normalize_link_is_case_insensitive_for_scheme_and_host() -> None:
    assert normalize_link("HTTPS://Loja.com/produto/123") == "https://loja.com/produto/123"


def test_signature_considers_link_when_present() -> None:
    with_link = compute_signature(1, "Promo", link="https://loja.com/produto/123")
    without_link = compute_signature(1, "Promo")
    other_link = compute_signature(1, "Promo", link="https://loja.com/produto/999")

    assert with_link != without_link
    assert with_link != other_link


def test_signature_treats_tracked_and_clean_links_as_the_same() -> None:
    a = compute_signature(1, "Promo", link="https://loja.com/produto/123?utm_source=x")
    b = compute_signature(1, "Promo", link="https://loja.com/produto/123/")

    assert a == b


# --- dedupe across sources -----------------------------------------------------


def test_same_promo_in_different_sources_dedupes_when_rule_opts_in() -> None:
    signature_a = compute_signature(1, "Promo iPhone", dedupe_across_sources=True)
    signature_b = compute_signature(2, "Promo iPhone", dedupe_across_sources=True)

    assert signature_a == signature_b


def test_same_promo_in_different_sources_stays_distinct_by_default() -> None:
    signature_a = compute_signature(1, "Promo iPhone")
    signature_b = compute_signature(2, "Promo iPhone")

    assert signature_a != signature_b


# --- time window ----------------------------------------------------------------


def test_duplicate_within_window_is_discarded() -> None:
    now = [0.0]
    cache = DedupeCache(window_seconds=60.0, clock=lambda: now[0])
    signature = compute_signature(1, "Promo iPhone")

    assert cache.should_process(signature) is True

    now[0] = 30.0
    assert cache.should_process(signature) is False


def test_duplicate_outside_window_generates_new_alert() -> None:
    now = [0.0]
    cache = DedupeCache(window_seconds=60.0, clock=lambda: now[0])
    signature = compute_signature(1, "Promo iPhone")

    assert cache.should_process(signature) is True

    now[0] = 61.0
    assert cache.should_process(signature) is True


def test_without_window_duplicate_is_always_discarded() -> None:
    now = [0.0]
    cache = DedupeCache(clock=lambda: now[0])
    signature = compute_signature(1, "Promo iPhone")

    assert cache.should_process(signature) is True

    now[0] = 10_000.0
    assert cache.should_process(signature) is False
