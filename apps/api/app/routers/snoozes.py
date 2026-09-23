"""S14-03: `POST/GET /snoozes`, `DELETE /snoozes/{id}` (F3).

Silencing only ever suppresses the delivery (`app.delivery_policy`); the
match keeps being persisted and published on SSE. `GET /snoozes` lists only
the active ones (`until > now`), each with a display label — the rule's name
or the product's title, taken from its most recent posting.
"""

from datetime import datetime, timedelta
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.main import get_current_session, get_db, require_csrf
from app.utc import UtcDatetime, utc_now
from models import Match, Rule, Snooze
from packages.rules.product import product_title

router = APIRouter(
    prefix="/snoozes",
    tags=["snoozes"],
    dependencies=[Depends(get_current_session)],
)


class SnoozeCreate(BaseModel):
    scope: Literal["rule", "product"]
    rule_id: int | None = None
    product_key: str | None = None
    # Exactly one of the two: a relative window from `now`, or an absolute
    # deadline. `until`, once parsed, is always aware UTC (`UtcDatetime`).
    days: int | None = None
    until: UtcDatetime | None = None


class SnoozeResponse(BaseModel):
    id: int
    scope: Literal["rule", "product"]
    rule_id: int | None
    product_key: str | None
    until: UtcDatetime
    label: str


def _label_maps(db: Session, snoozes: list[Snooze]) -> tuple[dict[int, str], dict[str, str]]:
    """Batch-resolve display labels for a page of snoozes — never one query per row.

    A rule's label is its name. A product's label is `product_title` of its
    most recently matched message; a product key with no match anymore (the
    row was deleted, in theory) falls back to the raw key.
    """
    rule_ids = {snooze.rule_id for snooze in snoozes if snooze.rule_id is not None}
    product_keys = {snooze.product_key for snooze in snoozes if snooze.product_key is not None}

    rule_names: dict[int, str] = {}
    if rule_ids:
        rule_names = dict(
            db.execute(select(Rule.id, Rule.name).where(Rule.id.in_(rule_ids))).tuples().all()
        )

    product_titles: dict[str, str] = {}
    if product_keys:
        rows = db.execute(
            select(Match.product_key, Match.message_text)
            .where(Match.product_key.in_(product_keys))
            .order_by(Match.matched_at.desc())
        ).all()
        for key, message_text in rows:
            if key in product_titles:
                continue
            title = product_title(message_text)
            if title is not None:
                product_titles[key] = title

    return rule_names, product_titles


def _to_response(
    snooze: Snooze, rule_names: dict[int, str], product_titles: dict[str, str]
) -> SnoozeResponse:
    if snooze.scope == "rule":
        assert snooze.rule_id is not None
        label = rule_names.get(snooze.rule_id, f"regra #{snooze.rule_id}")
    else:
        assert snooze.product_key is not None
        label = product_titles.get(snooze.product_key, snooze.product_key)

    return SnoozeResponse(
        id=snooze.id,
        scope=snooze.scope,  # type: ignore[arg-type]
        rule_id=snooze.rule_id,
        product_key=snooze.product_key,
        until=snooze.until,
        label=label,
    )


@router.get("", response_model=list[SnoozeResponse])
def list_snoozes(
    db: Session = Depends(get_db), now: datetime = Depends(utc_now)
) -> list[SnoozeResponse]:
    snoozes = list(
        db.scalars(select(Snooze).where(Snooze.until > now).order_by(Snooze.until.asc()))
    )
    rule_names, product_titles = _label_maps(db, snoozes)
    return [_to_response(snooze, rule_names, product_titles) for snooze in snoozes]


@router.post(
    "",
    response_model=SnoozeResponse,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_csrf)],
)
def create_snooze(
    payload: SnoozeCreate,
    db: Session = Depends(get_db),
    now: datetime = Depends(utc_now),
) -> SnoozeResponse:
    if payload.scope == "rule":
        if payload.rule_id is None or payload.product_key is not None:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="scope 'rule' requires rule_id and no product_key",
            )
        if db.get(Rule, payload.rule_id) is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="rule not found")
    else:
        if payload.product_key is None or payload.rule_id is not None:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="scope 'product' requires product_key and no rule_id",
            )

    if (payload.days is None) == (payload.until is None):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="informe exatamente um entre days e until",
        )

    if payload.days is not None:
        if payload.days <= 0:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="days must be positive",
            )
        until = now + timedelta(days=payload.days)
    else:
        assert payload.until is not None
        if payload.until <= now:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="until must be in the future",
            )
        until = payload.until

    # A new snooze for the same target replaces the previous one instead of
    # duplicating it — one active snooze per rule/product at a time.
    existing = db.scalar(
        select(Snooze).where(
            Snooze.scope == payload.scope,
            Snooze.rule_id == payload.rule_id,
            Snooze.product_key == payload.product_key,
        )
    )
    if existing is not None:
        db.delete(existing)
        db.flush()

    snooze = Snooze(
        scope=payload.scope,
        rule_id=payload.rule_id,
        product_key=payload.product_key,
        until=until,
    )
    db.add(snooze)
    db.commit()

    rule_names, product_titles = _label_maps(db, [snooze])
    return _to_response(snooze, rule_names, product_titles)


@router.delete(
    "/{snooze_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_csrf)],
)
def delete_snooze(snooze_id: int, db: Session = Depends(get_db)) -> Response:
    snooze = db.get(Snooze, snooze_id)
    if snooze is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="snooze not found")
    db.delete(snooze)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
