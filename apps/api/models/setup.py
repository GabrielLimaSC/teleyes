from datetime import UTC, datetime

from sqlalchemy import DateTime, String
from sqlalchemy.orm import Mapped, mapped_column

from models.base import Base

DIALOG_SCAN_ID = 1


class SecurityEvent(Base):
    """S19-02: audit trail of the setup wizard's security-relevant actions.

    `kind` and `detail` come from closed sets defined in code (`app.setup_events`);
    nothing user-supplied (no phone, no code, no name, no chat id) is ever stored.
    """

    __tablename__ = "security_event"

    id: Mapped[int] = mapped_column(primary_key=True)
    kind: Mapped[str] = mapped_column(String(48))
    detail: Mapped[str | None] = mapped_column(String(48), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(UTC)
    )


class DialogScan(Base):
    """S19-02: single-row mailbox for "list the groups this account can read".

    The listener owns the only Telegram connection that uses the session (using one
    auth key from two processes at once can make Telegram revoke it), so the api never
    connects: it asks here, the listener answers by filling `telegram_dialog`.
    """

    __tablename__ = "dialog_scan"

    id: Mapped[int] = mapped_column(primary_key=True, default=DIALOG_SCAN_ID)
    # idle | pending | running | done | failed
    state: Mapped[str] = mapped_column(String(16), default="idle")
    requested_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # Exception class name only.
    error: Mapped[str | None] = mapped_column(String(200), nullable=True)


class TelegramDialog(Base):
    """A group or channel the account can read, as last seen by the listener."""

    __tablename__ = "telegram_dialog"

    id: Mapped[int] = mapped_column(primary_key=True)
    telegram_chat_id: Mapped[str] = mapped_column(String(64), unique=True)
    title: Mapped[str] = mapped_column(String(300))
    # group | channel
    kind: Mapped[str] = mapped_column(String(16))
