from collections.abc import Sequence

from sqlalchemy import select
from sqlalchemy.orm import Session

from models import Source
from repositories.errors import NotFoundError, ValidationError


def _find_by_chat_id(session: Session, telegram_chat_id: str) -> Source | None:
    return session.scalar(select(Source).where(Source.telegram_chat_id == telegram_chat_id))


def create_source(session: Session, *, name: str, telegram_chat_id: str) -> Source:
    if _find_by_chat_id(session, telegram_chat_id) is not None:
        raise ValidationError(f"source with telegram_chat_id {telegram_chat_id} already exists")

    source = Source(name=name, telegram_chat_id=telegram_chat_id)
    session.add(source)
    session.flush()
    return source


def list_sources(session: Session, *, include_inactive: bool = False) -> Sequence[Source]:
    stmt = select(Source)
    if not include_inactive:
        stmt = stmt.where(Source.active.is_(True))
    return session.scalars(stmt).all()


def _get_source(session: Session, source_id: int) -> Source:
    source = session.get(Source, source_id)
    if source is None:
        raise NotFoundError(f"source {source_id} not found")
    return source


def update_source(
    session: Session,
    source_id: int,
    *,
    name: str | None = None,
    telegram_chat_id: str | None = None,
) -> Source:
    source = _get_source(session, source_id)

    if telegram_chat_id is not None and telegram_chat_id != source.telegram_chat_id:
        existing = _find_by_chat_id(session, telegram_chat_id)
        if existing is not None:
            raise ValidationError(
                f"source with telegram_chat_id {telegram_chat_id} already exists"
            )
        source.telegram_chat_id = telegram_chat_id
    if name is not None:
        source.name = name

    session.flush()
    return source


def pause_source(session: Session, source_id: int) -> Source:
    source = _get_source(session, source_id)
    source.active = False
    session.flush()
    return source


def delete_source(session: Session, source_id: int) -> None:
    source = _get_source(session, source_id)
    session.delete(source)
    session.flush()
