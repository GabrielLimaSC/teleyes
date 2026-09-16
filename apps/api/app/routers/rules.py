from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, ConfigDict
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.main import get_current_session, get_db, require_csrf
from models import Match, Rule
from repositories import rule_repo
from repositories.errors import NotFoundError, ValidationError

router = APIRouter(
    prefix="/rules",
    tags=["rules"],
    dependencies=[Depends(get_current_session)],
)


class RuleCreate(BaseModel):
    name: str
    include_terms: str
    exclude_terms: str | None = None
    max_price_cents: int | None = None


class RuleUpdate(BaseModel):
    name: str | None = None
    include_terms: str | None = None
    exclude_terms: str | None = None
    max_price_cents: int | None = None


class RuleResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    include_terms: str
    exclude_terms: str | None
    max_price_cents: int | None
    active: bool
    created_at: datetime
    lowest_price_cents: int | None = None


class ClearMatchesResponse(BaseModel):
    deleted: int


def _not_found(error: NotFoundError) -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(error))


@router.get("", response_model=list[RuleResponse])
def list_rules(
    include_inactive: bool = False,
    db: Session = Depends(get_db),
) -> list[RuleResponse]:
    """S7-06: `lowest_price_cents` (the true historical minimum among the
    rule's own priced matches, `None` with no priced match yet) is computed
    fresh here in one extra query — never persisted on `Rule`, same reasoning
    as `Match.is_lowest_price_ever` in `app.routers.matches`.
    """
    rules = list(rule_repo.list_rules(db, include_inactive=include_inactive))
    lowest_by_rule: dict[int, int | None] = dict(
        db.execute(
            select(Match.rule_id, func.min(Match.price_cents))
            .where(Match.price_cents.is_not(None))
            .group_by(Match.rule_id)
        )
        .tuples()
        .all()
    )
    return [
        RuleResponse.model_validate(rule).model_copy(
            update={"lowest_price_cents": lowest_by_rule.get(rule.id)}
        )
        for rule in rules
    ]


@router.post(
    "",
    response_model=RuleResponse,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_csrf)],
)
def create_rule(payload: RuleCreate, db: Session = Depends(get_db)) -> Rule:
    try:
        rule = rule_repo.create_rule(db, **payload.model_dump())
    except ValidationError as error:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(error)
        ) from error
    db.commit()
    return rule


@router.patch(
    "/{rule_id}",
    response_model=RuleResponse,
    dependencies=[Depends(require_csrf)],
)
def update_rule(rule_id: int, payload: RuleUpdate, db: Session = Depends(get_db)) -> Rule:
    try:
        rule = rule_repo.update_rule(db, rule_id, **payload.model_dump(exclude_unset=True))
    except ValidationError as error:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(error)
        ) from error
    except NotFoundError as error:
        raise _not_found(error) from error
    db.commit()
    return rule


@router.post(
    "/{rule_id}/pause",
    response_model=RuleResponse,
    dependencies=[Depends(require_csrf)],
)
def pause_rule(rule_id: int, db: Session = Depends(get_db)) -> Rule:
    try:
        rule = rule_repo.pause_rule(db, rule_id)
    except NotFoundError as error:
        raise _not_found(error) from error
    db.commit()
    return rule


@router.delete(
    "/{rule_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_csrf)],
)
def delete_rule(rule_id: int, db: Session = Depends(get_db)) -> Response:
    try:
        rule_repo.delete_rule(db, rule_id)
    except NotFoundError as error:
        raise _not_found(error) from error
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.delete(
    "/{rule_id}/matches",
    response_model=ClearMatchesResponse,
    dependencies=[Depends(require_csrf)],
)
def clear_rule_matches(rule_id: int, db: Session = Depends(get_db)) -> ClearMatchesResponse:
    """S10-04: apaga todo o histórico de matches (e deliveries) de uma
    regra — pedido do Gabriel pra limpar regras antigas mal configuradas
    sem mexer em código. A regra em si nunca é apagada nem pausada, só o
    histórico. Auditoria mínima: registra no log quantos matches saíram e
    de qual regra.
    """
    try:
        deleted = rule_repo.clear_rule_matches(db, rule_id)
    except NotFoundError as error:
        raise _not_found(error) from error
    db.commit()
    print(f"[rules] histórico limpo: rule_id={rule_id} matches_apagados={deleted}")
    return ClearMatchesResponse(deleted=deleted)
