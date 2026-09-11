from packages.rules.dedupe import DedupeCache, compute_signature


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
