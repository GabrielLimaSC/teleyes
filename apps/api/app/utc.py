"""The one place where a datetime crosses the API boundary (S13-01).

SQLite hands every `DateTime(timezone=True)` column back as a *naive*
`datetime` (the driver drops the zone), and Pydantic writes a naive value as
`"2026-09-20T01:43:00"` — no `Z`. A browser reads that string as *local*
time, so a Brazilian viewer saw every time 3h early. Everything persisted in
this project is UTC (the writers only ever pass `datetime.now(UTC)` or a
Telegram date normalised to UTC), so the fix is to say so on the way out:

* REST: declare response fields as `UtcDatetime` — a value is made aware-UTC
  on validation and Pydantic then serialises it with a trailing `Z`.
* SSE (a hand-built dict, not a response model): `format_utc` runs the same
  type through the same serialiser.

Never write a bare `datetime` field in a response model: `test_utc_serialization`
fails on it.
"""

from datetime import UTC, datetime
from typing import Annotated

from pydantic import AfterValidator, TypeAdapter


def ensure_utc(value: datetime) -> datetime:
    """Naive means "read back from SQLite", which is UTC by project rule."""
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


UtcDatetime = Annotated[datetime, AfterValidator(ensure_utc)]

_UTC_DATETIME_ADAPTER: TypeAdapter[datetime] = TypeAdapter(UtcDatetime)


def format_utc(value: datetime) -> str:
    """ISO 8601 with a `Z` suffix — exactly what a `UtcDatetime` response field emits."""
    return str(
        _UTC_DATETIME_ADAPTER.dump_python(_UTC_DATETIME_ADAPTER.validate_python(value), mode="json")
    )


def utc_now() -> datetime:
    """Current instant, aware UTC. A FastAPI dependency so tests can pin the clock."""
    return datetime.now(UTC)
