"""S19-04: `GET/POST /purchases`, `PUT/DELETE /purchases/{id}` — what the admin bought.

The only table filled by hand. It never stores Telegram content (no message text,
links or group names); `product_key` / `rule_id` are optional links used by the
savings report (`app.routers.savings_report`). Writes need the CSRF token.
"""

from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.main import get_current_session, get_db, require_csrf
from app.utc import UtcDatetime, utc_now
from models import Purchase, Rule

MAX_PRICE_CENTS = 100_000_000  # R$ 1.000.000,00 — a typo guard, not a business rule
FUTURE_TOLERANCE = timedelta(days=1)  # a date picked in a timezone ahead of UTC

router = APIRouter(
    prefix="/purchases",
    tags=["purchases"],
    dependencies=[Depends(get_current_session)],
)


def _clean_text(value: str | None) -> str | None:
    if value is None:
        return None
    cleaned = " ".join(value.split())
    return cleaned or None


class PurchaseInput(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    price_cents: int = Field(gt=0, le=MAX_PRICE_CENTS)
    purchased_at: UtcDatetime
    store: str | None = Field(default=None, max_length=80)
    product_key: str | None = Field(default=None, max_length=200)
    rule_id: int | None = None

    @field_validator("name", "store", "product_key", mode="before")
    @classmethod
    def _normalize(cls, value: object) -> object:
        return _clean_text(value) if isinstance(value, str) else value

    @field_validator("name")
    @classmethod
    def _name_not_blank(cls, value: str) -> str:
        if not value:
            raise ValueError("name must not be blank")
        return value


class PurchaseResponse(BaseModel):
    id: int
    name: str
    price_cents: int
    purchased_at: UtcDatetime
    store: str | None
    product_key: str | None
    rule_id: int | None
    created_at: UtcDatetime


def _to_response(purchase: Purchase) -> PurchaseResponse:
    return PurchaseResponse(
        id=purchase.id,
        name=purchase.name,
        price_cents=purchase.price_cents,
        purchased_at=purchase.purchased_at,
        store=purchase.store,
        product_key=purchase.product_key,
        rule_id=purchase.rule_id,
        created_at=purchase.created_at,
    )


def _validate(payload: PurchaseInput, db: Session, now: UtcDatetime) -> None:
    if payload.purchased_at > now + FUTURE_TOLERANCE:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="a data da compra não pode estar no futuro",
        )
    if payload.rule_id is not None and db.get(Rule, payload.rule_id) is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="rule not found")


def _apply(purchase: Purchase, payload: PurchaseInput) -> None:
    purchase.name = payload.name
    purchase.price_cents = payload.price_cents
    purchase.purchased_at = payload.purchased_at
    purchase.store = payload.store
    purchase.product_key = payload.product_key
    purchase.rule_id = payload.rule_id


def _get_or_404(db: Session, purchase_id: int) -> Purchase:
    purchase = db.get(Purchase, purchase_id)
    if purchase is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="purchase not found")
    return purchase


@router.get("", response_model=list[PurchaseResponse])
def list_purchases(db: Session = Depends(get_db)) -> list[PurchaseResponse]:
    rows = db.scalars(select(Purchase).order_by(Purchase.purchased_at.desc(), Purchase.id.desc()))
    return [_to_response(row) for row in rows]


@router.post(
    "",
    response_model=PurchaseResponse,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_csrf)],
)
def create_purchase(
    payload: PurchaseInput,
    db: Session = Depends(get_db),
    now: UtcDatetime = Depends(utc_now),
) -> PurchaseResponse:
    _validate(payload, db, now)
    purchase = Purchase()
    _apply(purchase, payload)
    db.add(purchase)
    db.commit()
    return _to_response(purchase)


@router.put(
    "/{purchase_id}",
    response_model=PurchaseResponse,
    dependencies=[Depends(require_csrf)],
)
def update_purchase(
    purchase_id: int,
    payload: PurchaseInput,
    db: Session = Depends(get_db),
    now: UtcDatetime = Depends(utc_now),
) -> PurchaseResponse:
    purchase = _get_or_404(db, purchase_id)
    _validate(payload, db, now)
    _apply(purchase, payload)
    db.commit()
    return _to_response(purchase)


@router.delete(
    "/{purchase_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_csrf)],
)
def delete_purchase(purchase_id: int, db: Session = Depends(get_db)) -> Response:
    purchase = _get_or_404(db, purchase_id)
    db.delete(purchase)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
