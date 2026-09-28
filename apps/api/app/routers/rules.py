
from datetime import UTC, datetime, timedelta
from datetime import date as LocalDate
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, ConfigDict
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.main import get_current_session, get_db, require_csrf
from app.pipeline import HISTORICAL_WINDOW, evaluate_rule, parse_terms
from app.product_history import daily_lowest, get_display_timezone
from app.utc import UtcDatetime, ensure_utc, utc_now
from models import Match, Rule, Snooze, Source
from packages.rules.normalize import normalize_text
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
    # S14-02: the rule's "Avise-me abaixo de" price target (F6). Validated
    # (> 0) in `repositories.rule_repo`, not here — the same
    # `ValidationError` -> 422 path `include_terms` already uses.
    target_price_cents: int | None = None


class RuleUpdate(BaseModel):
    name: str | None = None
    include_terms: str | None = None
    exclude_terms: str | None = None
    max_price_cents: int | None = None
    target_price_cents: int | None = None


class RuleHistoryPointResponse(BaseModel):
    date: LocalDate
    price_cents: int


class RuleResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    include_terms: str
    exclude_terms: str | None
    max_price_cents: int | None
    target_price_cents: int | None
    active: bool
    created_at: UtcDatetime
    lowest_price_cents: int | None = None
    # S14-03: `until` of the rule's active snooze (`until > now`), `None`
    # when it is not silenced. Computed fresh on every read, never stored.
    snoozed_until: UtcDatetime | None = None
    history_30d: list[RuleHistoryPointResponse] = []


class ClearMatchesResponse(BaseModel):
    deleted: int


class RuleTestRequest(BaseModel):
    """S13-07: same shape as `RuleCreate` minus `name` — a dry-run only ever
    needs the fields that actually affect matching. The schema has no
    source-scoping field on `Rule` at all (`app.pipeline.ListenerSource`'s
    own docstring: every active rule is evaluated against every active
    source's messages), so there is nothing to filter by here either.
    """

    include_terms: str
    exclude_terms: str | None = None
    max_price_cents: int | None = None


class RuleTestMatch(BaseModel):
    source_id: int
    source_name: str
    message_text: str
    price_cents: int | None
    price_cash_cents: int | None
    price_card_cents: int | None
    message_link: str | None
    matched_at: UtcDatetime
    matched_term: str


class RuleTestResponse(BaseModel):
    total_matched: int
    window_days: int
    messages: list[RuleTestMatch]


RULE_TEST_RESULT_LIMIT = 50


def _first_matching_term(include_terms: str, text: str) -> str:
    """Which include term (original casing, as typed) made `text` match —
    called only after `evaluate_rule` already confirmed a hit, so some term
    is always found; the fallback exists only to keep this total.
    """
    normalized_message = normalize_text(text)
    for term in parse_terms(include_terms):
        if normalize_text(term) in normalized_message:
            return term
    return ""


def _not_found(error: NotFoundError) -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(error))


@router.get("", response_model=list[RuleResponse])
def list_rules(
    include_inactive: bool = False,
    db: Session = Depends(get_db),
    now: datetime = Depends(utc_now),
    tz: ZoneInfo = Depends(get_display_timezone),
) -> list[RuleResponse]:
    """S7-06: `lowest_price_cents` (the true historical minimum among the
    rule's own priced matches, `None` with no priced match yet) is computed
    fresh here in one extra query — never persisted on `Rule`, same reasoning
    as `Match.is_lowest_price_ever` in `app.routers.matches`. S14-03:
    `snoozed_until` is the same kind of read-time computation, from `snooze`.
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
    # `model_copy(update=...)` below never re-validates (Pydantic v2), so the
    # `UtcDatetime` field's own aware-UTC conversion (`ensure_utc`) is never
    # applied to it — done here by hand instead, same fix as `app.utc`'s own
    # docstring warns about for every raw datetime crossing the API boundary.
    snoozed_until_by_rule: dict[int, datetime] = {
        rule_id: ensure_utc(until)
        for rule_id, until in db.execute(
            select(Snooze.rule_id, Snooze.until).where(Snooze.scope == "rule", Snooze.until > now)
        ).tuples()
        if rule_id is not None
    }
    priced_by_rule: dict[int, list[tuple[datetime, int]]] = {}
    for rule_id, matched_at, price_cents in db.execute(
        select(Match.rule_id, Match.matched_at, Match.price_cents).where(
            Match.price_cents.is_not(None), Match.matched_at >= now - timedelta(days=30)
        )
    ):
        assert price_cents is not None
        priced_by_rule.setdefault(rule_id, []).append((ensure_utc(matched_at), price_cents))
    history_by_rule = {
        rule_id: [
            RuleHistoryPointResponse(date=point.day, price_cents=point.price_cents)
            for point in daily_lowest(priced, tz)
        ]
        for rule_id, priced in priced_by_rule.items()
    }
    return [
        RuleResponse.model_validate(rule).model_copy(
            update={
                "lowest_price_cents": lowest_by_rule.get(rule.id),
                "snoozed_until": snoozed_until_by_rule.get(rule.id),
                "history_30d": history_by_rule.get(rule.id, []),
            }
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


@router.post(
    "/test",
    response_model=RuleTestResponse,
    dependencies=[Depends(require_csrf)],
)
def test_rule(payload: RuleTestRequest, db: Session = Depends(get_db)) -> RuleTestResponse:
    """S13-07: dry-run of a not-yet-saved rule form (create OR edit) against
    real history — Gabriel types terms/exclusions/ceiling, clicks "Testar"
    and sees which real recent messages would have matched, before ever
    saving. Reuses `app.pipeline.evaluate_rule`, the exact match -> price ->
    ceiling core the live and historical paths run, so a preview here behaves
    identically to what saving the rule for real would have caught. Reads
    only: never creates a `Match`/`Delivery`, never advances a
    `ProcessingCursor`, never calls `BotNotifier` — calling this ten times in
    a row has the same zero effect as calling it once.

    Data source and its limitation: this project retains message content
    only for messages that already matched SOME existing rule (`CLAUDE.md`/
    `PRODUCT.md` — rejected traffic keeps aggregate counters, never text), so
    there is no raw "every message seen" table to scan and this can't
    re-query Telegram live either (that's the real listener's job, not a form
    preview). The dry-run instead scans the pool of already-matched messages
    from the last `HISTORICAL_WINDOW` days — the same window
    `run_historical_scan` uses — deduplicated by real Telegram identity so a
    message that matched several existing rules is only evaluated once here.
    A message that never matched any existing rule was discarded upstream
    and its text was never persisted anywhere, so a rule aimed at genuinely
    new territory no existing rule already covers can legitimately preview
    as empty even though matching messages really arrived — this is the best
    real data available without inventing a live Telegram scrape here.
    """
    if not payload.include_terms.strip():
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="rule requires at least one include term",
        )

    candidate_rule = Rule(
        include_terms=payload.include_terms,
        exclude_terms=payload.exclude_terms,
        max_price_cents=payload.max_price_cents,
    )

    window_start = datetime.now(UTC) - HISTORICAL_WINDOW
    rows = db.execute(
        select(Match, Source.name)
        .join(Source, Source.id == Match.source_id)
        .where(Match.matched_at >= window_start)
        .order_by(Match.matched_at.desc(), Match.id.desc())
    ).all()

    seen_messages: set[tuple[int, int | str]] = set()
    hits: list[RuleTestMatch] = []
    for db_match, source_name in rows:
        # Real Telegram identity dedupes across rules that already matched
        # the same message; a NULL id (synthetic/demo/legacy input — see
        # `IncomingMessage`'s own docstring) has none, so each such row
        # counts as its own message instead of collapsing together.
        dedupe_key = (
            (db_match.source_id, db_match.telegram_message_id)
            if db_match.telegram_message_id is not None
            else (db_match.source_id, f"row-{db_match.id}")
        )
        if dedupe_key in seen_messages:
            continue
        seen_messages.add(dedupe_key)

        evaluation = evaluate_rule(candidate_rule, db_match.message_text)
        if evaluation.discard_reason is not None:
            continue

        hits.append(
            RuleTestMatch(
                source_id=db_match.source_id,
                source_name=source_name,
                message_text=db_match.message_text,
                price_cents=evaluation.price_cents,
                price_cash_cents=evaluation.price_cash_cents,
                price_card_cents=evaluation.price_card_cents,
                message_link=db_match.message_link,
                matched_at=db_match.matched_at,
                matched_term=_first_matching_term(payload.include_terms, db_match.message_text),
            )
        )

    return RuleTestResponse(
        total_matched=len(hits),
        window_days=HISTORICAL_WINDOW.days,
        messages=hits[:RULE_TEST_RESULT_LIMIT],
    )


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
