import pytest
from sqlalchemy.orm import Session

from repositories import recipient_repo, rule_repo, source_repo
from repositories.errors import NotFoundError, ValidationError

# --- rule_repo ---------------------------------------------------------------


def test_rule_crud_happy_path(session: Session) -> None:
    rule = rule_repo.create_rule(session, name="iPhone", include_terms="iphone")
    assert rule.id is not None
    assert rule.active is True

    rules = rule_repo.list_rules(session)
    assert [r.id for r in rules] == [rule.id]

    updated = rule_repo.update_rule(session, rule.id, name="iPhone Promo")
    assert updated.name == "iPhone Promo"

    paused = rule_repo.pause_rule(session, rule.id)
    assert paused.active is False
    assert rule_repo.list_rules(session) == []
    assert rule_repo.list_rules(session, include_inactive=True) == [paused]

    rule_repo.delete_rule(session, rule.id)
    assert rule_repo.list_rules(session, include_inactive=True) == []


def test_rule_without_include_terms_is_rejected(session: Session) -> None:
    with pytest.raises(ValidationError):
        rule_repo.create_rule(session, name="Vazia", include_terms="   ")

    assert rule_repo.list_rules(session, include_inactive=True) == []


def test_rule_update_not_found_raises(session: Session) -> None:
    with pytest.raises(NotFoundError):
        rule_repo.update_rule(session, 999, name="x")


def test_clear_rule_matches_for_a_missing_rule_raises(session: Session) -> None:
    with pytest.raises(NotFoundError):
        rule_repo.clear_rule_matches(session, 999)


def test_clear_rule_matches_returns_zero_and_deletes_nothing_when_the_rule_has_no_matches(
    session: Session,
) -> None:
    rule = rule_repo.create_rule(session, name="iPhone", include_terms="iphone")

    deleted = rule_repo.clear_rule_matches(session, rule.id)

    assert deleted == 0


# --- source_repo ---------------------------------------------------------------


def test_source_crud_happy_path(session: Session) -> None:
    source = source_repo.create_source(session, name="Grupo A", telegram_chat_id="-100111")
    assert source.active is True

    assert [s.id for s in source_repo.list_sources(session)] == [source.id]

    updated = source_repo.update_source(session, source.id, name="Grupo A Renomeado")
    assert updated.name == "Grupo A Renomeado"

    paused = source_repo.pause_source(session, source.id)
    assert paused.active is False
    assert source_repo.list_sources(session) == []

    source_repo.delete_source(session, source.id)
    assert source_repo.list_sources(session, include_inactive=True) == []


def test_source_with_duplicate_telegram_chat_id_is_rejected(session: Session) -> None:
    source_repo.create_source(session, name="Grupo A", telegram_chat_id="-100111")

    with pytest.raises(ValidationError):
        source_repo.create_source(session, name="Grupo B", telegram_chat_id="-100111")

    assert len(source_repo.list_sources(session, include_inactive=True)) == 1


# --- recipient_repo ---------------------------------------------------------------


def test_recipient_crud_happy_path(session: Session) -> None:
    recipient = recipient_repo.create_recipient(
        session, name="Gabriel", telegram_chat_id="999"
    )
    assert recipient.active is True
    assert recipient.allowlisted is False

    assert [r.id for r in recipient_repo.list_recipients(session)] == [recipient.id]

    updated = recipient_repo.update_recipient(session, recipient.id, allowlisted=True)
    assert updated.allowlisted is True

    paused = recipient_repo.pause_recipient(session, recipient.id)
    assert paused.active is False
    assert recipient_repo.list_recipients(session) == []

    recipient_repo.delete_recipient(session, recipient.id)
    assert recipient_repo.list_recipients(session, include_inactive=True) == []


def test_recipient_with_duplicate_telegram_chat_id_is_rejected(session: Session) -> None:
    recipient_repo.create_recipient(session, name="Gabriel", telegram_chat_id="999")

    with pytest.raises(ValidationError):
        recipient_repo.create_recipient(session, name="Namorada", telegram_chat_id="999")

    assert len(recipient_repo.list_recipients(session, include_inactive=True)) == 1
