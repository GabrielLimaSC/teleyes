"""S19-05: exports the GET responses of the demo API as static JSON fixtures.

Usage:
    python scripts/export_demo_fixtures.py [--out apps/web/src/demo-static/fixtures.json]

Seeds a throwaway SQLite database with the fictional demo data (S19-03, fixed clock
`REFERENCE_NOW`), runs the real FastAPI app in demo mode in memory (TestClient, no
network) and records every GET the dashboard makes, keyed by `path?query`. The static
demo site (`vite build --mode demo-static`) serves these instead of a backend and shifts
every timestamp by `load time - reference_now`, so the data always looks fresh.

Deterministic: same code and same seed give the same bytes. Nothing real can enter: the
database is created here, demo mode refuses anything without the `demo:` marker, and the
script asserts that every source/recipient id in the output starts with `demo:`.
"""

import argparse
import json
import os
import sys
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import quote

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUT = REPO_ROOT / "apps" / "web" / "src" / "demo-static" / "fixtures.json"
ALEMBIC_INI_PATH = REPO_ROOT / "apps" / "api" / "alembic.ini"
REFERENCE_NOW = datetime(2026, 6, 1, 15, 0, 0, tzinfo=UTC)
PRODUCT_RANGES = ("7d", "30d", "90d")
STATIC_PATHS = (
    "/health",
    "/rules",
    "/rules?include_inactive=true",
    "/sources",
    "/sources?include_inactive=true",
    "/recipients",
    "/recipients?include_inactive=true",
    "/matches",
    "/metrics",
    "/digest",
    "/settings/feed",
    "/snoozes",
    "/listener/status",
)


def _build_client(db_path: Path) -> Any:
    """Seeds `db_path` and returns a logged-in TestClient of the demo app."""
    os.environ.update(
        DATABASE_URL=f"sqlite:///{db_path}",
        TELEYES_DEMO="1",
        TELEYES_DEMO_READONLY="1",
        TELEYES_DEMO_LIVE="0",
    )
    # Imported late: app.main reads the environment above at import time.
    from alembic import command
    from alembic.config import Config
    from fastapi.testclient import TestClient

    from app.demo_mode import DEMO_PASSWORD
    from app.demo_seed import seed_demo_database
    from app.main import app
    from app.utc import utc_now
    from models.db import get_engine, get_sessionmaker

    command.upgrade(Config(str(ALEMBIC_INI_PATH)), "head")
    seed_demo_database(get_sessionmaker(get_engine(os.environ["DATABASE_URL"])), now=REFERENCE_NOW)
    app.dependency_overrides[utc_now] = lambda: REFERENCE_NOW
    # No `with`: the lifespan (heartbeat/watchers) must not run under a fixed clock.
    client = TestClient(app, base_url="http://localhost")
    login = client.post("/auth/login", json={"password": DEMO_PASSWORD})
    login.raise_for_status()
    return client


def _get(client: Any, path: str) -> Any:
    response = client.get(path)
    response.raise_for_status()
    return response.json()


def collect(client: Any) -> dict[str, Any]:
    fixtures: dict[str, Any] = {path: _get(client, path) for path in STATIC_PATHS}
    keys = sorted({match["product_key"] for match in fixtures["/matches"] if match["product_key"]})
    for key in keys:
        encoded = quote(key, safe="")
        for product_range in PRODUCT_RANGES:
            path = f"/products/{encoded}?range={product_range}"
            fixtures[path] = _get(client, path)
        suggestion = f"/products/{encoded}/rule-suggestion"
        fixtures[suggestion] = _get(client, suggestion)
    return fixtures


def pin_runtime_fields(fixtures: dict[str, Any]) -> None:
    """Values read from the real clock/process, not from the seed: pin them.

    The dashboard is meant to look alive, so the listener is online and the api has
    been up for a while; `uptime_seconds` would also differ on every run.
    """
    fixtures["/health"]["uptime_seconds"] = 3 * 86400 + 4 * 3600
    fixtures["/listener/status"]["listener_online"] = True


def assert_only_fictional(fixtures: dict[str, Any]) -> None:
    for path in ("/sources?include_inactive=true", "/recipients?include_inactive=true"):
        for row in fixtures[path]:
            chat_id = row.get("telegram_chat_id")
            if chat_id is not None and not str(chat_id).startswith("demo:"):
                raise SystemExit(f"{path}: id fora do marcador demo: {chat_id!r}")


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()

    sys.path[:0] = [str(REPO_ROOT / "apps" / "api"), str(REPO_ROOT)]
    with tempfile.TemporaryDirectory() as scratch:
        client = _build_client(Path(scratch) / "demo.db")
        fixtures = collect(client)
    pin_runtime_fields(fixtures)
    assert_only_fictional(fixtures)

    reference = REFERENCE_NOW.isoformat().replace("+00:00", "Z")
    document = {"reference_now": reference, "routes": fixtures}
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(
        json.dumps(document, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    size_kb = args.out.stat().st_size / 1024
    print(f"{len(fixtures)} routes, {size_kb:.0f} KB -> {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
