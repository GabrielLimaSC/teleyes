from collections.abc import Sequence

from sqlalchemy import select
from sqlalchemy.orm import Session

from models import Recipient
from repositories.errors import NotFoundError, ValidationError


def _find_by_chat_id(session: Session, telegram_chat_id: str) -> Recipient | None:
    return session.scalar(
        select(Recipient).where(Recipient.telegram_chat_id == telegram_chat_id)
    )


def create_recipient(
    session: Session, *, name: str, telegram_chat_id: str, allowlisted: bool = False
) -> Recipient:
    if _find_by_chat_id(session, telegram_chat_id) is not None:
        raise ValidationError(
            f"recipient with telegram_chat_id {telegram_chat_id} already exists"
        )

    recipient = Recipient(name=name, telegram_chat_id=telegram_chat_id, allowlisted=allowlisted)
    session.add(recipient)
    session.flush()
    return recipient


def list_recipients(session: Session, *, include_inactive: bool = False) -> Sequence[Recipient]:
    stmt = select(Recipient)
    if not include_inactive:
        stmt = stmt.where(Recipient.active.is_(True))
    return session.scalars(stmt).all()


def _get_recipient(session: Session, recipient_id: int) -> Recipient:
    recipient = session.get(Recipient, recipient_id)
    if recipient is None:
        raise NotFoundError(f"recipient {recipient_id} not found")
    return recipient


def update_recipient(
    session: Session,
    recipient_id: int,
    *,
    name: str | None = None,
    telegram_chat_id: str | None = None,
    allowlisted: bool | None = None,
) -> Recipient:
    recipient = _get_recipient(session, recipient_id)

    if telegram_chat_id is not None and telegram_chat_id != recipient.telegram_chat_id:
        existing = _find_by_chat_id(session, telegram_chat_id)
        if existing is not None:
            raise ValidationError(
                f"recipient with telegram_chat_id {telegram_chat_id} already exists"
            )
        recipient.telegram_chat_id = telegram_chat_id
    if name is not None:
        recipient.name = name
    if allowlisted is not None:
        recipient.allowlisted = allowlisted

    session.flush()
    return recipient


def pause_recipient(session: Session, recipient_id: int) -> Recipient:
    recipient = _get_recipient(session, recipient_id)
    recipient.active = False
    session.flush()
    return recipient


def delete_recipient(session: Session, recipient_id: int) -> None:
    recipient = _get_recipient(session, recipient_id)
    session.delete(recipient)
    session.flush()
