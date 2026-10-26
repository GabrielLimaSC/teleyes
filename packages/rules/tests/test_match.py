import pytest

from packages.rules.match import MatchRule, split_term_parts, term_error, terms_error


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


# --- S17-06: " + " means "all parts, any order" ---------------------------

SAMSUNG_RAM = "Memória Ram Samsung 16GB, Ddr5, 5600mhz"
CORSAIR_RAM = "Memória RAM Gamer Corsair Vengeance RGB 16GB DDR5"


def test_and_term_matches_real_ram_titles_with_brand_in_the_middle() -> None:
    rule = MatchRule(include_terms=["memoria ram + 16gb ddr5"])

    assert rule.matches(SAMSUNG_RAM) is True  # "16GB, Ddr5" -> contiguous after normalizing
    assert rule.matches(CORSAIR_RAM) is True


def test_and_term_needs_every_part_and_ignores_order() -> None:
    rule = MatchRule(include_terms=["16gb + memoria ram"])

    assert rule.matches(SAMSUNG_RAM) is True
    assert rule.matches("Memória Ram Samsung 8GB") is False
    assert rule.matches("Pen drive 16GB") is False


def test_without_plus_the_term_stays_one_contiguous_run() -> None:
    rule = MatchRule(include_terms=["memoria ram 16gb ddr5"])

    assert rule.matches(SAMSUNG_RAM) is False
    assert rule.matches("Memoria RAM 16GB DDR5 kit") is True


def test_blocked_and_term_vetoes_only_when_all_parts_present() -> None:
    rule = MatchRule(include_terms=["ssd"], exclude_terms=["ssd + 512"])

    assert rule.matches("SSD Kingston 512GB") is False
    assert rule.matches("SSD Kingston 1TB") is True


def test_notebook_is_blocked_by_plain_blocked_term() -> None:
    rule = MatchRule(include_terms=["memoria ram + 16gb"], exclude_terms=["notebook"])

    assert rule.matches("Memória Ram 16GB para Notebook") is False
    assert rule.matches(CORSAIR_RAM) is True


def test_plus_without_spaces_on_both_sides_stays_literal() -> None:
    assert MatchRule(include_terms=["5g+"]).matches("Roteador 5G+ novo") is True
    assert MatchRule(include_terms=["5g+"]).matches("Roteador 5G novo") is True  # legacy: "5g"
    assert MatchRule(include_terms=["a+"]).matches("Linha A+ premium") is True
    assert split_term_parts("5g+") == ["5g+"]


def test_spaces_around_plus_are_ignored() -> None:
    assert split_term_parts("memoria ram   +   16gb") == ["memoria ram", "16gb"]
    assert MatchRule(include_terms=["memoria ram+ 16gb"]).matches(SAMSUNG_RAM) is False


def test_blocked_by_and_first_include_hit_report_the_term() -> None:
    rule = MatchRule(include_terms=["pc", "memoria ram + ddr5"], exclude_terms=["ssd + 512"])

    assert rule.first_include_hit(CORSAIR_RAM) == "memoria ram + ddr5"
    assert rule.blocked_by("SSD 512GB") is True
    assert rule.blocked_by("SSD 1TB") is False


@pytest.mark.parametrize("term", ["memoria ram +", "+ 16gb", "+", "a + ! + b", "a +  + b"])
def test_dangling_plus_is_an_error(term: str) -> None:
    assert term_error(term) is not None


@pytest.mark.parametrize("term", ["memoria ram + 16gb", "5g+", "a+", "iphone", "a+ + b"])
def test_well_formed_terms_have_no_error(term: str) -> None:
    assert term_error(term) is None


def test_terms_error_checks_each_comma_separated_term() -> None:
    assert terms_error("ok, memoria ram +") is not None
    assert terms_error("ok, a + b") is None
    assert terms_error(None) is None
