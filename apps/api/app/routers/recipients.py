from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, ConfigDict
from sqlalchemy.orm import Session

from app.main import get_current_session, get_db, require_csrf
from models import Recipient
from repositories import recipient_repo
from repositories.errors import NotFoundError, ValidationError

router = APIRouter(
    prefix="/recipients",
    tags=["recipients"],
    dependencies=[Depends(get_current_session)],
)


class RecipientCreate(BaseModel):
    name: str
    telegram_chat_id: str
    allowlisted: bool = False


class RecipientUpdate(BaseModel):
    name: str | None = None
    telegram_chat_id: str | None = None
    allowlisted: bool | None = None


class RecipientResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    telegram_chat_id: str
    allowlisted: bool
    active: bool
    created_at: datetime


def _not_found(error: NotFoundError) -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(error))


def _conflict(error: ValidationError) -> HTTPException:
    return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error))


@router.get("", response_model=list[RecipientResponse])
def list_recipients(
    include_inactive: bool = False,
    db: Session = Depends(get_db),
) -> list[Recipient]:
    return list(recipient_repo.list_recipients(db, include_inactive=include_inactive))


@router.post(
    "",
    response_model=RecipientResponse,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_csrf)],
)
def create_recipient(payload: RecipientCreate, db: Session = Depends(get_db)) -> Recipient:
    try:
        recipient = recipient_repo.create_recipient(db, **payload.model_dump())
    except ValidationError as error:
        raise _conflict(error) from error
    db.commit()
    return recipient


@router.patch(
    "/{recipient_id}",
    response_model=RecipientResponse,
    dependencies=[Depends(require_csrf)],
)
def update_recipient(
    recipient_id: int,
    payload: RecipientUpdate,
    db: Session = Depends(get_db),
) -> Recipient:
    try:
        recipient = recipient_repo.update_recipient(
            db, recipient_id, **payload.model_dump(exclude_unset=True)
        )
    except ValidationError as error:
        raise _conflict(error) from error
    except NotFoundError as error:
        raise _not_found(error) from error
    db.commit()
    return recipient


@router.post(
    "/{recipient_id}/pause",
    response_model=RecipientResponse,
    dependencies=[Depends(require_csrf)],
)
def pause_recipient(recipient_id: int, db: Session = Depends(get_db)) -> Recipient:
    try:
        recipient = recipient_repo.pause_recipient(db, recipient_id)
    except NotFoundError as error:
        raise _not_found(error) from error
    db.commit()
    return recipient


@router.delete(
    "/{recipient_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_csrf)],
)
def delete_recipient(recipient_id: int, db: Session = Depends(get_db)) -> Response:
    try:
        recipient_repo.delete_recipient(db, recipient_id)
    except NotFoundError as error:
        raise _not_found(error) from error
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
