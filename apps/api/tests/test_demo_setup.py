from sqlalchemy.orm import Session

from app.demo_setup import DemoSetup, ensure_demo_setup
from repositories import recipient_repo


def _call(
    session: Session,
    *,
    source_name: str = "Grupo Teste",
    rule_include_terms: str = "iphone",
    recipient_name: str = "Gabriel",
) -> DemoSetup:
    return ensure_demo_setup(
        session,
        source_chat_id="-100123",
        source_name=source_name,
        rule_name="Demo",
        include_terms=rule_include_terms,
        exclude_terms=None,
        max_price_cents=None,
        recipient_chat_id="999",
        recipient_name=recipient_name,
    )


async def test_ensure_demo_setup_creates_all_three_on_first_call(session: Session) -> None:
    setup = _call(session)
    session.commit()

    assert setup.source.telegram_chat_id == "-100123"
    assert setup.rule.name == "Demo"
    assert setup.rule.include_terms == "iphone"
    assert setup.recipient.telegram_chat_id == "999"
    assert setup.recipient.allowlisted is True


async def test_ensure_demo_setup_reuses_existing_source_and_recipient_by_chat_id(
    session: Session,
) -> None:
    first = _call(session)
    session.commit()

    second = _call(session, source_name="Nome Diferente", recipient_name="Outro Nome")
    session.commit()

    assert second.source.id == first.source.id
    assert second.source.name == "Grupo Teste"  # not overwritten
    assert second.recipient.id == first.recipient.id


async def test_ensure_demo_setup_reuses_existing_rule_by_name(session: Session) -> None:
    first = _call(session)
    session.commit()

    second = _call(session, rule_include_terms="samsung")
    session.commit()

    assert second.rule.id == first.rule.id
    assert second.rule.include_terms == "iphone"  # first write wins, not overwritten


async def test_ensure_demo_setup_allowlists_an_existing_non_allowlisted_recipient(
    session: Session,
) -> None:
    recipient_repo.create_recipient(
        session, name="Gabriel", telegram_chat_id="999", allowlisted=False
    )
    session.commit()

    setup = _call(session)
    session.commit()

    assert setup.recipient.allowlisted is True
