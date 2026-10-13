from datetime import UTC, datetime
from typing import Any

from sqlalchemy import JSON, DateTime, ForeignKey
from sqlalchemy.orm import Mapped, mapped_column

from models.base import Base


class MatchCorrection(Base):
    """S14-06 (F7): audit trail for one manual edit or "Reverter ao
    detectado" on a `Match` — one row per match actually touched by a
    `PATCH /matches/{id}` or a `POST /matches/{id}/revert` call
    (`apps/api/app/routers/matches.py`), including each sibling match a
    `apply_name_to_product: true` rename reaches.

    `changes` is `{field: {"before": ..., "after": ...}}` for exactly the
    fields that call actually changed — never a full snapshot, and
    `message_text` never appears in it: raw message content is never
    rewritten (CLAUDE.md). `admin_id` is the session's own admin (v1 has
    exactly one row in `admin`, enforced by application code only).
    """

    __tablename__ = "match_correction"

    id: Mapped[int] = mapped_column(primary_key=True)
    match_id: Mapped[int] = mapped_column(ForeignKey("match.id"), index=True)
    admin_id: Mapped[int] = mapped_column(ForeignKey("admin.id"))
    changes: Mapped[dict[str, Any]] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(UTC)
    )
