"""S14-04 (F4): `GET/PUT /digest` — the single `digest_settings` row, plus
"Próximo envio" and the pending queue for the panel.

Authenticated the same way every other configuration route is
(`get_current_session` on the router, `require_csrf` on the write) — no new
auth pattern. `PUT` validates `send_at_local` (`HH:MM`) and `top_n` (1-50) at
the Pydantic layer, same 422 shape as `POST /rules`'s own validation.
"""

from datetime import datetime
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends
from pydantic import BaseModel, field_validator
from sqlalchemy.orm import Session

from app.digest import DigestQueueItem, load_pending_queue, local_date_for, next_run_at
from app.digest_settings import load_digest_settings, parse_send_at_local, save_digest_settings
from app.main import get_current_session, get_db, require_csrf
from app.product_history import get_display_timezone
from app.utc import UtcDatetime, utc_now
from models import DigestRun, DigestSettings

router = APIRouter(prefix="/digest", tags=["digest"], dependencies=[Depends(get_current_session)])


class DigestQueueItemResponse(BaseModel):
    match_id: int
    price_cents: int | None
    title: str
    message_link: str | None
    matched_at: UtcDatetime


class DigestSettingsResponse(BaseModel):
    enabled: bool
    send_at_local: str
    top_n: int
    mute_individual: bool
    # Instant (UTC) and the same instant rendered in `display_timezone`, so
    # the panel never has to reimplement the timezone arithmetic itself.
    next_run_at_utc: UtcDatetime
    next_run_at_local: str
    queue_count: int
    queue: list[DigestQueueItemResponse]


class DigestSettingsUpdate(BaseModel):
    enabled: bool
    send_at_local: str
    top_n: int
    mute_individual: bool

    @field_validator("send_at_local")
    @classmethod
    def _valid_hhmm(cls, value: str) -> str:
        try:
            parse_send_at_local(value)
        except ValueError as error:
            raise ValueError("send_at_local deve estar no formato HH:MM") from error
        return value

    @field_validator("top_n")
    @classmethod
    def _top_n_range(cls, value: int) -> int:
        if not 1 <= value <= 50:
            raise ValueError("top_n deve estar entre 1 e 50")
        return value


def _build_response(
    db: Session, settings: DigestSettings, now: datetime, tz: ZoneInfo
) -> DigestSettingsResponse:
    already_ran_today = db.get(DigestRun, local_date_for(now, tz)) is not None
    send_at = parse_send_at_local(settings.send_at_local)
    next_run_utc = next_run_at(
        now_utc=now, tz=tz, send_at_local=send_at, already_ran_today=already_ran_today
    )
    queue = load_pending_queue(db)
    return DigestSettingsResponse(
        enabled=settings.enabled,
        send_at_local=settings.send_at_local,
        top_n=settings.top_n,
        mute_individual=settings.mute_individual,
        next_run_at_utc=next_run_utc,
        next_run_at_local=next_run_utc.astimezone(tz).strftime("%Y-%m-%d %H:%M"),
        queue_count=len(queue),
        queue=[_to_queue_item(item) for item in queue],
    )


def _to_queue_item(item: DigestQueueItem) -> DigestQueueItemResponse:
    return DigestQueueItemResponse(
        match_id=item.match_id,
        price_cents=item.price_cents,
        title=item.title,
        message_link=item.message_link,
        matched_at=item.matched_at,
    )


@router.get("", response_model=DigestSettingsResponse)
def get_digest(
    db: Session = Depends(get_db),
    now: datetime = Depends(utc_now),
    tz: ZoneInfo = Depends(get_display_timezone),
) -> DigestSettingsResponse:
    settings = load_digest_settings(db)
    return _build_response(db, settings, now, tz)


@router.put("", response_model=DigestSettingsResponse, dependencies=[Depends(require_csrf)])
def put_digest(
    payload: DigestSettingsUpdate,
    db: Session = Depends(get_db),
    now: datetime = Depends(utc_now),
    tz: ZoneInfo = Depends(get_display_timezone),
) -> DigestSettingsResponse:
    settings = save_digest_settings(
        db,
        enabled=payload.enabled,
        send_at_local=payload.send_at_local,
        top_n=payload.top_n,
        mute_individual=payload.mute_individual,
    )
    return _build_response(db, settings, now, tz)
