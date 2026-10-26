"""S19-02: listing the groups the Telegram account can already read.

Read-only by construction: the only Telethon call is `iter_dialogs`, which lists. The
app never joins, replies, reacts or forwards (CLAUDE.md).

The listener is the only process that connects with the session, so the api cannot do
this itself. The panel writes a *request* into the single `dialog_scan` row, the
listener claims it (`DialogScanWorker`), lists the dialogs and replaces
`telegram_dialog`, then marks the row `done` (or `failed` with an exception class
name). Same mailbox pattern as `listener_control`.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Protocol

from sqlalchemy import delete, select, update
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session, sessionmaker

from models import DialogScan, TelegramDialog
from models.setup import DIALOG_SCAN_ID

logger = logging.getLogger(__name__)

IN_FLIGHT = ("pending", "running")
# A `running` scan older than this belongs to a listener that died mid-way.
STALE_AFTER = timedelta(minutes=2)
MAX_DIALOGS = 2000
POLL_SECONDS = 2.0


@dataclass(frozen=True)
class DialogInfo:
    chat_id: str
    title: str
    kind: str  # group | channel


class DialogLike(Protocol):
    id: int
    name: str | None
    is_group: bool
    is_channel: bool
    is_user: bool


class DialogLister(Protocol):
    def iter_dialogs(self) -> AsyncIterator[DialogLike]: ...


def _ensure_row(session: Session) -> None:
    session.execute(
        sqlite_insert(DialogScan)
        .values(id=DIALOG_SCAN_ID, state="idle")
        .on_conflict_do_nothing(index_elements=["id"])
    )
    session.commit()


def request_scan(session: Session, *, now: datetime | None = None) -> bool:
    """Panel side. `False` when a scan is already in flight (not stale)."""
    moment = now or datetime.now(UTC)
    _ensure_row(session)
    row = session.get(DialogScan, DIALOG_SCAN_ID)
    assert row is not None
    session.refresh(row)
    requested = _aware(row.requested_at)
    if row.state in IN_FLIGHT and requested is not None and moment - requested < STALE_AFTER:
        return False
    session.execute(
        update(DialogScan)
        .where(DialogScan.id == DIALOG_SCAN_ID)
        .values(state="pending", requested_at=moment, finished_at=None, error=None)
    )
    session.commit()
    return True


def claim_scan(session: Session) -> bool:
    """Listener side: `pending` -> `running`, atomically."""
    result = session.execute(
        update(DialogScan)
        .where(DialogScan.id == DIALOG_SCAN_ID, DialogScan.state == "pending")
        .values(state="running")
    )
    session.commit()
    return result.rowcount == 1  # type: ignore[attr-defined]


def finish_scan(
    session: Session, dialogs: list[DialogInfo], *, now: datetime | None = None
) -> None:
    _ensure_row(session)
    session.execute(delete(TelegramDialog))
    session.add_all(
        TelegramDialog(telegram_chat_id=d.chat_id, title=d.title, kind=d.kind) for d in dialogs
    )
    session.execute(
        update(DialogScan)
        .where(DialogScan.id == DIALOG_SCAN_ID)
        .values(state="done", finished_at=now or datetime.now(UTC), error=None)
    )
    session.commit()


def fail_scan(session: Session, error_class: str, *, now: datetime | None = None) -> None:
    _ensure_row(session)
    session.execute(
        update(DialogScan)
        .where(DialogScan.id == DIALOG_SCAN_ID)
        .values(state="failed", finished_at=now or datetime.now(UTC), error=error_class[:200])
    )
    session.commit()


def clear_dialogs(session: Session) -> None:
    """Forget the cached list (used when the Telegram account is disconnected)."""
    session.execute(delete(TelegramDialog))
    session.execute(
        update(DialogScan)
        .where(DialogScan.id == DIALOG_SCAN_ID)
        .values(state="idle", requested_at=None, finished_at=None, error=None)
    )
    session.commit()


@dataclass(frozen=True)
class ScanSnapshot:
    state: str
    finished_at: datetime | None
    error: str | None
    dialogs: list[DialogInfo]


def read_scan(session: Session, *, now: datetime | None = None) -> ScanSnapshot:
    moment = now or datetime.now(UTC)
    row = session.get(DialogScan, DIALOG_SCAN_ID)
    if row is None:
        return ScanSnapshot("idle", None, None, [])
    state = row.state
    requested = _aware(row.requested_at)
    if state in IN_FLIGHT and requested is not None and moment - requested >= STALE_AFTER:
        state = "failed"
    dialogs = [
        DialogInfo(chat_id=d.telegram_chat_id, title=d.title, kind=d.kind)
        for d in session.scalars(select(TelegramDialog).order_by(TelegramDialog.title))
    ]
    return ScanSnapshot(state, _aware(row.finished_at), row.error, dialogs)


def _aware(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value if value.tzinfo is not None else value.replace(tzinfo=UTC)


async def list_groups(client: DialogLister) -> list[DialogInfo]:
    """Groups and channels only: no private chats, no bots. Never writes to Telegram."""
    found: list[DialogInfo] = []
    async for dialog in client.iter_dialogs():
        if dialog.is_user or not (dialog.is_group or dialog.is_channel):
            continue
        title = (dialog.name or "").strip() or str(dialog.id)
        found.append(
            DialogInfo(
                chat_id=str(dialog.id),
                title=title[:300],
                kind="group" if dialog.is_group else "channel",
            )
        )
        if len(found) >= MAX_DIALOGS:
            break
    return found


class DialogScanWorker:
    def __init__(
        self,
        *,
        session_factory: sessionmaker[Session],
        client: Any,
        is_connected: Callable[[], bool],
    ) -> None:
        self._session_factory = session_factory
        self._client = client
        self._is_connected = is_connected

    async def poll_once(self) -> bool:
        if not self._is_connected():
            return False
        with self._session_factory() as session:
            if not claim_scan(session):
                return False
        try:
            dialogs = await list_groups(self._client)
        except Exception as error:
            # Class name only: nothing from Telegram is copied into the row or the log.
            error_class = type(error).__name__
            logger.error("event=dialog_scan_failed error_class=%s", error_class)
            with self._session_factory() as session:
                fail_scan(session, error_class)
            return True
        with self._session_factory() as session:
            finish_scan(session, dialogs)
        logger.info("event=dialog_scan_done dialogs=%d", len(dialogs))
        return True

    async def run(self, stop_event: asyncio.Event, poll_seconds: float = POLL_SECONDS) -> None:
        while not stop_event.is_set():
            try:
                await self.poll_once()
            except Exception as error:
                logger.error("event=dialog_scan_poll_failed error_class=%s", type(error).__name__)
            try:
                await asyncio.wait_for(stop_event.wait(), timeout=poll_seconds)
            except TimeoutError:
                pass
