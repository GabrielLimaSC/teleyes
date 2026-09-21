
from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.main import get_current_session, get_db
from app.utc import UtcDatetime
from packages.metrics.counters import MetricCounter, MetricReason

router = APIRouter(
    prefix="/metrics",
    tags=["metrics"],
    dependencies=[Depends(get_current_session)],
)


class MetricResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    source_id: int | None
    reason: MetricReason
    count: int
    updated_at: UtcDatetime


@router.get("", response_model=list[MetricResponse])
def list_metrics(db: Session = Depends(get_db)) -> list[MetricResponse]:
    statement = select(MetricCounter).order_by(MetricCounter.source_id, MetricCounter.reason)
    counters = db.scalars(statement).all()
    return [MetricResponse.model_validate(counter) for counter in counters]
