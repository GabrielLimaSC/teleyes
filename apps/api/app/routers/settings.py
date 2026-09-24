"""S14-05 (F5): `GET/PUT /settings/feed` — for now, just the "Agrupar
duplicatas" toggle (`app.feed_settings`, single-row `feed_settings` table).
"""

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.feed_settings import get_group_duplicates, set_group_duplicates
from app.main import get_current_session, get_db, require_csrf

router = APIRouter(
    prefix="/settings",
    tags=["settings"],
    dependencies=[Depends(get_current_session)],
)


class FeedSettingsResponse(BaseModel):
    group_duplicates: bool


class FeedSettingsUpdate(BaseModel):
    group_duplicates: bool


@router.get("/feed", response_model=FeedSettingsResponse)
def get_feed_settings(db: Session = Depends(get_db)) -> FeedSettingsResponse:
    return FeedSettingsResponse(group_duplicates=get_group_duplicates(db))


@router.put(
    "/feed",
    response_model=FeedSettingsResponse,
    dependencies=[Depends(require_csrf)],
)
def update_feed_settings(
    payload: FeedSettingsUpdate, db: Session = Depends(get_db)
) -> FeedSettingsResponse:
    row = set_group_duplicates(db, payload.group_duplicates)
    return FeedSettingsResponse(group_duplicates=row.group_duplicates)
