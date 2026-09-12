from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, ConfigDict
from sqlalchemy.orm import Session

from app.main import get_current_session, get_db, require_csrf
from models import Source
from repositories import source_repo
from repositories.errors import NotFoundError, ValidationError

router = APIRouter(
    prefix="/sources",
    tags=["sources"],
    dependencies=[Depends(get_current_session)],
)


class SourceCreate(BaseModel):
    name: str
    telegram_chat_id: str


class SourceUpdate(BaseModel):
    name: str | None = None
    telegram_chat_id: str | None = None


class SourceResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    telegram_chat_id: str
    active: bool
    created_at: datetime


def _not_found(error: NotFoundError) -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(error))


def _conflict(error: ValidationError) -> HTTPException:
    return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error))


@router.get("", response_model=list[SourceResponse])
def list_sources(
    include_inactive: bool = False,
    db: Session = Depends(get_db),
) -> list[Source]:
    return list(source_repo.list_sources(db, include_inactive=include_inactive))


@router.post(
    "",
    response_model=SourceResponse,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_csrf)],
)
def create_source(payload: SourceCreate, db: Session = Depends(get_db)) -> Source:
    try:
        source = source_repo.create_source(db, **payload.model_dump())
    except ValidationError as error:
        raise _conflict(error) from error
    db.commit()
    return source


@router.patch(
    "/{source_id}",
    response_model=SourceResponse,
    dependencies=[Depends(require_csrf)],
)
def update_source(source_id: int, payload: SourceUpdate, db: Session = Depends(get_db)) -> Source:
    try:
        source = source_repo.update_source(
            db, source_id, **payload.model_dump(exclude_unset=True)
        )
    except ValidationError as error:
        raise _conflict(error) from error
    except NotFoundError as error:
        raise _not_found(error) from error
    db.commit()
    return source


@router.post(
    "/{source_id}/pause",
    response_model=SourceResponse,
    dependencies=[Depends(require_csrf)],
)
def pause_source(source_id: int, db: Session = Depends(get_db)) -> Source:
    try:
        source = source_repo.pause_source(db, source_id)
    except NotFoundError as error:
        raise _not_found(error) from error
    db.commit()
    return source


@router.delete(
    "/{source_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_csrf)],
)
def delete_source(source_id: int, db: Session = Depends(get_db)) -> Response:
    try:
        source_repo.delete_source(db, source_id)
    except NotFoundError as error:
        raise _not_found(error) from error
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
