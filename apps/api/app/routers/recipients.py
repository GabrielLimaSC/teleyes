

from datetime import datetime, timedelta
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.main import get_current_session, get_db, require_csrf
from app.utc import UtcDatetime, utc_now
from models import Match, Recipient, Rule
from models.recipient import RULES_MODE_ALL
from packages.rules.target import target_hit
from repositories import recipient_repo
from repositories.errors import InvalidSettingsError, NotFoundError, ValidationError

router = APIRouter(
    prefix="/recipients",
    tags=["recipients"],
    dependencies=[Depends(get_current_session)],
)


class RecipientCreate(BaseModel):
    name: str
    telegram_chat_id: str
    allowlisted: bool = False
    # S21-06 (F8)
    rules_mode: str = RULES_MODE_ALL
    rule_ids: list[int] = []
    notify_target: bool = True
    notify_common: bool = True


class RecipientUpdate(BaseModel):
    name: str | None = None
    telegram_chat_id: str | None = None
    allowlisted: bool | None = None
    rules_mode: str | None = None
    rule_ids: list[int] | None = None
    notify_target: bool | None = None
    notify_common: bool | None = None


class RecipientResponse(BaseModel):
    id: int
    name: str
    telegram_chat_id: str
    allowlisted: bool
    active: bool
    created_at: UtcDatetime
    rules_mode: str
    rule_ids: list[int]
    notify_target: bool
    notify_common: bool


class PreviewRuleCount(BaseModel):
    rule_id: int
    per_week: int


class RecipientPreviewResponse(BaseModel):
    alerts_per_week: int
    per_rule: list[PreviewRuleCount]


def _to_response(recipient: Recipient, rule_ids: list[int]) -> RecipientResponse:
    return RecipientResponse(
        id=recipient.id,
        name=recipient.name,
        telegram_chat_id=recipient.telegram_chat_id,
        allowlisted=recipient.allowlisted,
        active=recipient.active,
        created_at=recipient.created_at,
        rules_mode=recipient.rules_mode,
        rule_ids=rule_ids,
        notify_target=recipient.notify_target,
        notify_common=recipient.notify_common,
    )


def _invalid(error: InvalidSettingsError) -> HTTPException:
    return HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(error))


def _not_found(error: NotFoundError) -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(error))


def _conflict(error: ValidationError) -> HTTPException:
    return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error))


@router.get("", response_model=list[RecipientResponse])
def list_recipients(
    include_inactive: bool = False,
    db: Session = Depends(get_db),
) -> list[RecipientResponse]:
    ids = recipient_repo.rule_ids_by_recipient(db)
    return [
        _to_response(recipient, ids.get(recipient.id, []))
        for recipient in recipient_repo.list_recipients(db, include_inactive=include_inactive)
    ]


PREVIEW_WINDOW = timedelta(days=7)


def _parse_rule_ids(raw: list[str]) -> list[int]:
    try:
        return [int(part) for item in raw for part in item.split(",") if part.strip()]
    except ValueError as error:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="rule_ids inválido."
        ) from error


@router.get("/preview", response_model=RecipientPreviewResponse)
def preview_recipient(
    rules_mode: str = RULES_MODE_ALL,
    rule_ids: Annotated[list[str] | None, Query()] = None,
    notify_target: bool = True,
    notify_common: bool = True,
    db: Session = Depends(get_db),
    now: datetime = Depends(utc_now),
) -> RecipientPreviewResponse:
    """S21-06 (F8): "~N alertas/semana" for a recipient form that is still being
    filled in: matches of the last 7 days of the chosen (active) rules, counted
    only for the alert types switched on. A match is a target hit when its
    price reaches its rule's target, same test the pipeline uses.
    """
    chosen = _parse_rule_ids(rule_ids or [])
    try:
        recipient_repo.validate_delivery_settings(
            db,
            rules_mode=rules_mode,
            rule_ids=chosen,
            notify_target=notify_target,
            notify_common=notify_common,
        )
    except InvalidSettingsError as error:
        raise _invalid(error) from error
    rules_query = select(Rule).where(Rule.active.is_(True))
    if rules_mode != RULES_MODE_ALL:
        rules_query = rules_query.where(Rule.id.in_(chosen))
    rules = list(db.scalars(rules_query.order_by(Rule.id)))
    counts = {rule.id: 0 for rule in rules}
    targets = {rule.id: rule.target_price_cents for rule in rules}
    for rule_id, price_cents in db.execute(
        select(Match.rule_id, Match.price_cents).where(
            Match.rule_id.in_(counts), Match.matched_at >= now - PREVIEW_WINDOW
        )
    ):
        is_target = target_hit(price_cents, targets[rule_id])
        if (is_target and notify_target) or (not is_target and notify_common):
            counts[rule_id] += 1
    return RecipientPreviewResponse(
        alerts_per_week=sum(counts.values()),
        per_rule=[PreviewRuleCount(rule_id=rid, per_week=n) for rid, n in counts.items()],
    )


@router.post(
    "",
    response_model=RecipientResponse,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_csrf)],
)
def create_recipient(payload: RecipientCreate, db: Session = Depends(get_db)) -> RecipientResponse:
    try:
        recipient = recipient_repo.create_recipient(db, **payload.model_dump())
    except InvalidSettingsError as error:
        raise _invalid(error) from error
    except ValidationError as error:
        raise _conflict(error) from error
    response = _to_response(recipient, recipient_repo.get_rule_ids(db, recipient.id))
    db.commit()
    return response


@router.patch(
    "/{recipient_id}",
    response_model=RecipientResponse,
    dependencies=[Depends(require_csrf)],
)
def update_recipient(
    recipient_id: int,
    payload: RecipientUpdate,
    db: Session = Depends(get_db),
) -> RecipientResponse:
    try:
        recipient = recipient_repo.update_recipient(
            db, recipient_id, **payload.model_dump(exclude_unset=True)
        )
    except InvalidSettingsError as error:
        raise _invalid(error) from error
    except ValidationError as error:
        raise _conflict(error) from error
    except NotFoundError as error:
        raise _not_found(error) from error
    response = _to_response(recipient, recipient_repo.get_rule_ids(db, recipient.id))
    db.commit()
    return response


@router.post(
    "/{recipient_id}/pause",
    response_model=RecipientResponse,
    dependencies=[Depends(require_csrf)],
)
def pause_recipient(recipient_id: int, db: Session = Depends(get_db)) -> RecipientResponse:
    try:
        recipient = recipient_repo.pause_recipient(db, recipient_id)
    except NotFoundError as error:
        raise _not_found(error) from error
    response = _to_response(recipient, recipient_repo.get_rule_ids(db, recipient.id))
    db.commit()
    return response


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
