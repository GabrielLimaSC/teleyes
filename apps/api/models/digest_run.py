from datetime import UTC, date, datetime

from sqlalchemy import Date, DateTime
from sqlalchemy.orm import Mapped, mapped_column

from models.base import Base


class DigestRun(Base):
    """S14-04 (F4): one row per local calendar day the digest scheduler ran.

    `local_date` is the primary key on purpose, not a separate unique
    constraint on an autoincrement id: idempotency is the entire point of this
    table (`app.digest.run_digest_once` reads it before doing anything else),
    so "does today's local day already have a row" must be a single, atomic
    primary-key lookup, not a query — a restart mid-day or two overlapping
    scheduler ticks can never both pass that check and send twice.

    Whether the run actually delivered anything is not what this row answers
    — that honesty (`not_configured` never fakes delivery) lives on each
    `Delivery` row, kind="digest". This row only ever means "today's local day
    was already processed", including the empty-queue case (S14-04 done_when:
    no pending items still records a run, so a `GET /digest` never shows an
    empty day as still due).
    """

    __tablename__ = "digest_run"

    local_date: Mapped[date] = mapped_column(Date, primary_key=True)
    ran_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(UTC)
    )
    # How many pending items were folded into the digest text sent this run
    # (0 for an empty-queue day) and how many overflowed past `top_n` and were
    # marked `digest_skipped` instead of staying pending forever.
    items_sent: Mapped[int] = mapped_column(default=0)
    items_skipped: Mapped[int] = mapped_column(default=0)
