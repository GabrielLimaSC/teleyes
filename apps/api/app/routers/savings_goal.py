"""S21-08: `GET/PUT/DELETE /savings/goal` — the single savings goal (amount + deadline).

The goal is a number and a date the admin typed; it never holds Telegram content.
Progress is computed by `GET /savings/report` from the estimate it already shows.
Writes need the CSRF token (and the demo read-only middleware blocks them in the demo).
"""

from datetime import date
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.main import get_current_session, get_db, require_csrf
from app.product_history import get_display_timezone
from app.utc import UtcDatetime, utc_now
from models import SavingsGoal

MAX_GOAL_CENTS = 100_000_000  # R$ 1.000.000,00 — a typo guard, not a business rule
GOAL_ID = 1

router = APIRouter(
    prefix="/savings",
    tags=["savings"],
    dependencies=[Depends(get_current_session)],
)


class SavingsGoalInput(BaseModel):
    amount_cents: int = Field(gt=0, le=MAX_GOAL_CENTS)
    deadline: date


class SavingsGoalResponse(BaseModel):
    amount_cents: int
    deadline: date
    created_at: UtcDatetime
    updated_at: UtcDatetime


def _to_response(goal: SavingsGoal) -> SavingsGoalResponse:
    return SavingsGoalResponse(
        amount_cents=goal.amount_cents,
        deadline=goal.deadline,
        created_at=goal.created_at,
        updated_at=goal.updated_at,
    )


@router.get("/goal", response_model=SavingsGoalResponse | None)
def get_goal(db: Session = Depends(get_db)) -> SavingsGoalResponse | None:
    goal = db.get(SavingsGoal, GOAL_ID)
    return None if goal is None else _to_response(goal)


@router.put("/goal", response_model=SavingsGoalResponse, dependencies=[Depends(require_csrf)])
def put_goal(
    payload: SavingsGoalInput,
    db: Session = Depends(get_db),
    now: UtcDatetime = Depends(utc_now),
    tz: ZoneInfo = Depends(get_display_timezone),
) -> SavingsGoalResponse:
    if payload.deadline <= now.astimezone(tz).date():
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="o prazo da meta precisa estar no futuro",
        )
    goal = db.get(SavingsGoal, GOAL_ID)
    stamp = now
    if goal is None:
        goal = SavingsGoal(id=GOAL_ID, created_at=stamp)
        db.add(goal)
    goal.amount_cents = payload.amount_cents
    goal.deadline = payload.deadline
    goal.updated_at = stamp
    db.commit()
    return _to_response(goal)


@router.delete(
    "/goal", status_code=status.HTTP_204_NO_CONTENT, dependencies=[Depends(require_csrf)]
)
def delete_goal(db: Session = Depends(get_db)) -> Response:
    goal = db.get(SavingsGoal, GOAL_ID)
    if goal is not None:
        db.delete(goal)
        db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
