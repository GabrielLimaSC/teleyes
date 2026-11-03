from datetime import UTC, datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, String
from sqlalchemy.orm import Mapped, mapped_column

from models.base import Base


class AdminSession(Base):
    """S21-12: a persistent dashboard session.

    The primary key is the SHA-256 of the cookie token, never the token: a leaked
    database (backup, copied volume) does not hand out working cookies. The CSRF token
    is derived from the cookie token (see `auth.session`), so nothing in this row can
    reconstruct it either.
    """

    __tablename__ = "admin_session"
    __table_args__ = (Index("ix_admin_session_expires_at", "expires_at"),)

    id_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    admin_id: Mapped[int] = mapped_column(ForeignKey("admin.id", ondelete="CASCADE"))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(UTC)
    )
    last_seen_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(UTC)
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    remember: Mapped[bool] = mapped_column(Boolean, default=False)
