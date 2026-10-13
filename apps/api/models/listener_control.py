from datetime import UTC, datetime

from sqlalchemy import DateTime, String
from sqlalchemy.orm import Mapped, mapped_column

from models.base import Base

# The only row that ever exists: the panel and the listener talk through it.
LISTENER_CONTROL_ID = 1


class ListenerControl(Base):
    """S13-06: single-row mailbox between the panel (`api`) and the `listener`.

    The panel only writes a *request* (`state="pending"`); the listener notices
    it by polling, reloads its configuration in process and writes the outcome
    back. No process ever needs the Docker socket. Nothing here stores message
    content: only counters, timestamps and the class name of a failure.
    """

    __tablename__ = "listener_control"

    id: Mapped[int] = mapped_column(primary_key=True, default=LISTENER_CONTROL_ID)
    # idle | pending | applying | failed
    state: Mapped[str] = mapped_column(String(16), default="idle")
    reload_requested_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    reload_applied_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    last_sources_loaded: Mapped[int | None] = mapped_column(nullable=True)
    last_rules_loaded: Mapped[int | None] = mapped_column(nullable=True)
    last_recipients_loaded: Mapped[int | None] = mapped_column(nullable=True)
    # New matches the last apply found in the historical window (never alerted).
    last_new_matches: Mapped[int | None] = mapped_column(nullable=True)
    # Sources whose historical scan did not finish (the config still went live).
    last_scan_failures: Mapped[int | None] = mapped_column(nullable=True)
    # Exception class name only, never `str(error)` (it could carry message text).
    last_error: Mapped[str | None] = mapped_column(String(200), nullable=True)
    # Fingerprint of the configuration the listener is running with; the panel
    # compares it with a fresh one to say "há mudanças ainda não aplicadas".
    applied_config_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    listener_seen_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(UTC),
        onupdate=lambda: datetime.now(UTC),
    )
