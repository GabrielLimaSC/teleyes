from collections.abc import Callable, Iterator

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.main import get_current_session, get_db, require_csrf
from models import Recipient
from packages.notifications.bot import BotNotifier

BotNotifierFactory = Callable[[set[str]], BotNotifier]

router = APIRouter(
    prefix="/notifications",
    tags=["notifications"],
    dependencies=[Depends(get_current_session)],
)


class TestNotificationRequest(BaseModel):
    chat_id: str = Field(min_length=1, max_length=64)
    text: str = Field(default="Teste de notificação do teleyes.", min_length=1, max_length=4096)


class TestNotificationResponse(BaseModel):
    delivered: bool
    status: str
    recipient_id: int
    chat_id: str


def get_bot_notifier_factory(request: Request) -> BotNotifierFactory:
    factory: BotNotifierFactory = request.app.state.bot_notifier_factory
    return factory


@router.post(
    "/test",
    response_model=TestNotificationResponse,
    dependencies=[Depends(require_csrf)],
)
async def test_notification(
    payload: TestNotificationRequest,
    request: Request,
    db: Session = Depends(get_db),
    notifier_factory: BotNotifierFactory = Depends(get_bot_notifier_factory),
) -> TestNotificationResponse:
    recipient = db.scalar(
        select(Recipient).where(Recipient.telegram_chat_id == payload.chat_id)
    )
    if recipient is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="recipient not found",
        )
    if not recipient.active or not recipient.allowlisted:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="recipient must be active and allowlisted",
        )

    notifier = notifier_factory({recipient.telegram_chat_id})
    test_ids: Iterator[int] = request.app.state.notification_test_ids
    try:
        result = await notifier.notify(
            match_id=next(test_ids),
            recipient_id=recipient.id,
            chat_id=recipient.telegram_chat_id,
            text=payload.text,
        )
    except Exception as error:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="notification delivery failed",
        ) from error

    if result.reason == "not_allowlisted":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="recipient must be active and allowlisted",
        )
    if result.reason == "duplicate":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="notification test already sent",
        )

    return TestNotificationResponse(
        delivered=result.delivered,
        status="sent" if result.delivered else (result.reason or "failed"),
        recipient_id=recipient.id,
        chat_id=recipient.telegram_chat_id,
    )
