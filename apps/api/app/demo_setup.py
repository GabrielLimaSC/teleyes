from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session

from models import Recipient, Rule, Source
from repositories import recipient_repo, rule_repo, source_repo


@dataclass
class DemoSetup:
    source: Source
    rule: Rule
    recipient: Recipient


def ensure_demo_setup(
    session: Session,
    *,
    source_chat_id: str,
    source_name: str,
    rule_name: str,
    include_terms: str,
    exclude_terms: str | None,
    max_price_cents: int | None,
    recipient_chat_id: str,
    recipient_name: str,
) -> DemoSetup:
    """Get-or-create the Source/Rule/Recipient a demo run needs.

    Source and Recipient are keyed by `telegram_chat_id` (already unique in
    the schema). `Rule` has no natural key yet, so it's keyed by `name` here
    — a convention specific to this demo helper, not a schema constraint.
    """
    source = _get_or_create_source(session, source_chat_id, source_name)
    rule = _get_or_create_rule(session, rule_name, include_terms, exclude_terms, max_price_cents)
    recipient = _get_or_create_recipient(session, recipient_chat_id, recipient_name)
    return DemoSetup(source=source, rule=rule, recipient=recipient)


def _get_or_create_source(session: Session, chat_id: str, name: str) -> Source:
    existing = session.scalar(select(Source).where(Source.telegram_chat_id == chat_id))
    if existing is not None:
        return existing
    return source_repo.create_source(session, name=name, telegram_chat_id=chat_id)


def _get_or_create_recipient(session: Session, chat_id: str, name: str) -> Recipient:
    existing = session.scalar(select(Recipient).where(Recipient.telegram_chat_id == chat_id))
    if existing is not None:
        if not existing.allowlisted:
            existing.allowlisted = True
            session.flush()
        return existing
    return recipient_repo.create_recipient(
        session, name=name, telegram_chat_id=chat_id, allowlisted=True
    )


def _get_or_create_rule(
    session: Session,
    name: str,
    include_terms: str,
    exclude_terms: str | None,
    max_price_cents: int | None,
) -> Rule:
    existing = session.scalar(select(Rule).where(Rule.name == name))
    if existing is not None:
        return existing
    return rule_repo.create_rule(
        session,
        name=name,
        include_terms=include_terms,
        exclude_terms=exclude_terms,
        max_price_cents=max_price_cents,
    )
