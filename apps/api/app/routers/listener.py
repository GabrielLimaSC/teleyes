from typing import Literal

from fastapi import APIRouter, Depends, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.listener_control import ControlSnapshot, read_snapshot, request_reload
from app.main import get_current_session, get_db, require_csrf
from app.utc import UtcDatetime

router = APIRouter(
    prefix="/listener",
    tags=["listener"],
    dependencies=[Depends(get_current_session)],
)


class ListenerStatusResponse(BaseModel):
    """What the panel shows about "Aplicar regras" (S13-06).

    `error` is the class name of the last failure, never a message: nothing that
    could quote a Telegram message leaves the listener.
    """

    state: Literal["idle", "pending", "applying", "failed"]
    reload_requested_at: UtcDatetime | None
    reload_applied_at: UtcDatetime | None
    sources_loaded: int | None
    rules_loaded: int | None
    recipients_loaded: int | None
    new_matches: int | None
    scan_failures: int | None
    error: str | None
    # True when an active source/rule/recipient differs from what the listener
    # loaded — including pause, delete and edit, not only "created after".
    has_unapplied_changes: bool
    # The listener writes a heartbeat; False means it has not been heard from
    # for a while (down, restarting, or without Telegram credentials).
    listener_online: bool
    listener_seen_at: UtcDatetime | None


def _to_response(snapshot: ControlSnapshot) -> ListenerStatusResponse:
    return ListenerStatusResponse(
        state=snapshot.state,
        reload_requested_at=snapshot.reload_requested_at,
        reload_applied_at=snapshot.reload_applied_at,
        sources_loaded=snapshot.sources_loaded,
        rules_loaded=snapshot.rules_loaded,
        recipients_loaded=snapshot.recipients_loaded,
        new_matches=snapshot.new_matches,
        scan_failures=snapshot.scan_failures,
        error=snapshot.error,
        has_unapplied_changes=snapshot.has_unapplied_changes,
        listener_online=snapshot.listener_online,
        listener_seen_at=snapshot.listener_seen_at,
    )


@router.get("/status", response_model=ListenerStatusResponse)
def get_listener_status(db: Session = Depends(get_db)) -> ListenerStatusResponse:
    return _to_response(read_snapshot(db))


@router.post(
    "/reload",
    response_model=ListenerStatusResponse,
    status_code=status.HTTP_202_ACCEPTED,
    dependencies=[Depends(require_csrf)],
)
def reload_listener(db: Session = Depends(get_db)) -> ListenerStatusResponse:
    """Ask the listener to reload its configuration.

    Only writes a request into the database; the listener process picks it up
    by polling and applies it in process (no Docker socket, no restart). A
    request made while another is `pending`/`applying` is ignored — the answer
    is the same 202 with the current state, so a double click is harmless.
    """
    request_reload(db)
    return _to_response(read_snapshot(db))
