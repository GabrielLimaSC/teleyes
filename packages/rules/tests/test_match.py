from packages.rules.match import MatchRule


def test_positive_term_matches_when_present() -> None:
    rule = MatchRule(include_terms=["iphone"])

    assert rule.matches("Promoção IPHONE 15 128GB") is True


def test_positive_term_does_not_match_when_absent() -> None:
    rule = MatchRule(include_terms=["iphone"])

    assert rule.matches("Samsung Galaxy S24 em promoção") is False


def test_alternative_terms_match_with_any_one_present() -> None:
    rule = MatchRule(include_terms=["iphone", "celular"])

    assert rule.matches("Celular novo chegou, últimas unidades") is True


def test_blocklist_vetoes_match_even_with_positive_term() -> None:
    rule = MatchRule(include_terms=["iphone"], exclude_terms=["usado", "seminovo"])

    assert rule.matches("Iphone usado barato, aceito troca") is False


def test_matching_is_robust_to_case_accent_and_punctuation() -> None:
    rule = MatchRule(include_terms=["promoção"])

    assert rule.matches("PROMOCAO IMPERDÍVEL!!! Corre lá") is True


def test_rule_without_include_terms_never_matches() -> None:
    rule = MatchRule(include_terms=[])

    assert rule.matches("qualquer coisa") is False
