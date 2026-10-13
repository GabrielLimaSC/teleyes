"""The panel <-> listener mailbox (S13-06), database side.

`api` and `listener` are two processes that share one SQLite file and, on
purpose, nothing else: the API must not get the Docker socket (that would be
root on the host for a web service). So the panel writes a *request* into the
single `listener_control` row, the listener polls it and reloads its
configuration in process, and writes the outcome back into the same row.

Every state change below is one atomic `UPDATE ... WHERE state = ...`, so two
requests, or a request racing the listener's own claim, can never both win.
Nothing here ever stores message content, and a failure is recorded as its
exception class name only.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Literal

from sqlalchemy import select, update
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session

from app.utc import ensure_utc
from models import ListenerControl, Recipient, Rule, Source
from models.listener_control import LISTENER_CONTROL_ID

ListenerState = Literal["idle", "pending", "applying", "failed"]

IN_FLIGHT_STATES = ("pending", "applying")
# The listener writes a heartbeat at most this often (writes are cheap but not free)...
HEARTBEAT_MIN_INTERVAL = timedelta(seconds=30)
# ...so the panel treats it as gone after this much silence (three missed beats).
LISTENER_STALE_AFTER = timedelta(seconds=90)


def load_active_config(session: Session) -> tuple[list[Source], list[Rule], list[Recipient]]:
    """What the listener runs on: active sources and rules, and recipients that
    are both active and allowlisted. Shared by the listener and the panel so the
    "unapplied changes" check compares exactly the same thing.
    """
    sources = list(session.scalars(select(Source).where(Source.active.is_(True))))
    rules = list(session.scalars(select(Rule).where(Rule.active.is_(True))))
    recipients = list(
        session.scalars(
            select(Recipient).where(Recipient.active.is_(True), Recipient.allowlisted.is_(True))
        )
    )
    return sources, rules, recipients


def config_fingerprint(
    sources: Sequence[Source], rules: Sequence[Rule], recipients: Sequence[Recipient]
) -> str:
    """Stable digest of every field that changes what the listener does.

    Names are left out on purpose: renaming a rule or a group changes nothing
    about matching, listening or delivery, so it must not raise the "há
    mudanças não aplicadas" notice. Pausing, deleting, editing terms/ceiling or
    changing a chat id all change the digest, because they change the active set.
    """
    payload = {
        "sources": sorted((s.id, s.telegram_chat_id) for s in sources),
        "rules": sorted(
            (r.id, r.include_terms, r.exclude_terms or "", r.max_price_cents) for r in rules
        ),
        "recipients": sorted((r.id, r.telegram_chat_id) for r in recipients),
    }
    encoded = json.dumps(payload, separators=(",", ":"), default=str).encode()
    return hashlib.sha256(encoded).hexdigest()


def current_fingerprint(session: Session) -> str:
    return config_fingerprint(*load_active_config(session))


EMPTY_CONFIG_FINGERPRINT = config_fingerprint([], [], [])


def ensure_control_row(session: Session) -> None:
    """Create the single row if missing. Safe if `api` and `listener` race here."""
    session.execute(
        sqlite_insert(ListenerControl)
        .values(id=LISTENER_CONTROL_ID, state="idle", updated_at=datetime.now(UTC))
        .on_conflict_do_nothing(index_elements=["id"])
    )
    session.commit()


def request_reload(session: Session, *, now: datetime | None = None) -> bool:
    """Ask the listener to reload. `False` when a request is already in flight
    (`pending`/`applying`): a duplicate is ignored, never queued.
    """
    moment = now or datetime.now(UTC)
    ensure_control_row(session)
    result = session.execute(
        update(ListenerControl)
        .where(
            ListenerControl.id == LISTENER_CONTROL_ID,
            ListenerControl.state.not_in(IN_FLIGHT_STATES),
        )
        .values(state="pending", reload_requested_at=moment, updated_at=moment)
    )
    session.commit()
    return result.rowcount == 1  # type: ignore[attr-defined]


def claim_reload(session: Session, *, now: datetime | None = None) -> bool:
    """Listener side: turn `pending` into `applying`, atomically."""
    moment = now or datetime.now(UTC)
    result = session.execute(
        update(ListenerControl)
        .where(ListenerControl.id == LISTENER_CONTROL_ID, ListenerControl.state == "pending")
        .values(state="applying", updated_at=moment)
    )
    session.commit()
    return result.rowcount == 1  # type: ignore[attr-defined]


def record_applied(
    session: Session,
    *,
    sources_loaded: int,
    rules_loaded: int,
    recipients_loaded: int,
    config_hash: str,
    new_matches: int | None = None,
    scan_failures: int | None = None,
    now: datetime | None = None,
) -> None:
    """The listener is running the configuration described here (boot or reload)."""
    moment = now or datetime.now(UTC)
    ensure_control_row(session)
    session.execute(
        update(ListenerControl)
        .where(ListenerControl.id == LISTENER_CONTROL_ID)
        .values(
            state="idle",
            reload_applied_at=moment,
            last_sources_loaded=sources_loaded,
            last_rules_loaded=rules_loaded,
            last_recipients_loaded=recipients_loaded,
            last_new_matches=new_matches,
            last_scan_failures=scan_failures,
            last_error=None,
            applied_config_hash=config_hash,
            listener_seen_at=moment,
            updated_at=moment,
        )
    )
    session.commit()


def record_boot_scan(
    session: Session, *, new_matches: int, scan_failures: int, now: datetime | None = None
) -> None:
    """Fill in what the boot-time historical scan found, once it has finished."""
    moment = now or datetime.now(UTC)
    session.execute(
        update(ListenerControl)
        .where(ListenerControl.id == LISTENER_CONTROL_ID)
        .values(last_new_matches=new_matches, last_scan_failures=scan_failures, updated_at=moment)
    )
    session.commit()


def record_failed(session: Session, *, error_class: str, now: datetime | None = None) -> None:
    """A reload failed: the previous configuration keeps running (state `failed`)."""
    moment = now or datetime.now(UTC)
    session.execute(
        update(ListenerControl)
        .where(ListenerControl.id == LISTENER_CONTROL_ID)
        .values(state="failed", last_error=error_class[:200], updated_at=moment)
    )
    session.commit()


def touch_listener_seen(session: Session, *, now: datetime | None = None) -> None:
    """Heartbeat, throttled to `HEARTBEAT_MIN_INTERVAL` inside the statement."""
    moment = now or datetime.now(UTC)
    session.execute(
        update(ListenerControl)
        .where(
            ListenerControl.id == LISTENER_CONTROL_ID,
            (ListenerControl.listener_seen_at.is_(None))
            | (ListenerControl.listener_seen_at <= moment - HEARTBEAT_MIN_INTERVAL),
        )
        .values(listener_seen_at=moment)
    )
    session.commit()


@dataclass(frozen=True)
class ControlSnapshot:
    state: ListenerState
    reload_requested_at: datetime | None
    reload_applied_at: datetime | None
    sources_loaded: int | None
    rules_loaded: int | None
    recipients_loaded: int | None
    new_matches: int | None
    scan_failures: int | None
    error: str | None
    has_unapplied_changes: bool
    listener_online: bool
    listener_seen_at: datetime | None


def _utc_or_none(value: datetime | None) -> datetime | None:
    return None if value is None else ensure_utc(value)


def read_snapshot(session: Session, *, now: datetime | None = None) -> ControlSnapshot:
    """Read-only view for `GET /listener/status`. Never creates the row: a
    listener that has not reported yet reads as `idle` with nothing applied.
    """
    moment = now or datetime.now(UTC)
    row = session.get(ListenerControl, LISTENER_CONTROL_ID)
    applied_hash = (row.applied_config_hash if row else None) or EMPTY_CONFIG_FINGERPRINT
    seen_at = _utc_or_none(row.listener_seen_at) if row else None
    state: ListenerState = "idle"
    if row is not None and row.state in ("idle", "pending", "applying", "failed"):
        state = row.state  # type: ignore[assignment]
    return ControlSnapshot(
        state=state,
        reload_requested_at=_utc_or_none(row.reload_requested_at) if row else None,
        reload_applied_at=_utc_or_none(row.reload_applied_at) if row else None,
        sources_loaded=row.last_sources_loaded if row else None,
        rules_loaded=row.last_rules_loaded if row else None,
        recipients_loaded=row.last_recipients_loaded if row else None,
        new_matches=row.last_new_matches if row else None,
        scan_failures=row.last_scan_failures if row else None,
        error=row.last_error if row else None,
        has_unapplied_changes=current_fingerprint(session) != applied_hash,
        listener_online=seen_at is not None and moment - seen_at <= LISTENER_STALE_AFTER,
        listener_seen_at=seen_at,
    )
