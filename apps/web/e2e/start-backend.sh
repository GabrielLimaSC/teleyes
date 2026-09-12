#!/usr/bin/env bash
# Starts a real FastAPI backend for the Playwright smoke test: fresh scratch
# SQLite DB, one seeded admin, no Telegram/bot credentials (runs from a
# directory with no .env, so pydantic-settings falls back to defaults).
set -euo pipefail

WEB_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "$WEB_DIR/../.." && pwd)"
SCRATCH_DIR="$WEB_DIR/e2e/.scratch"
DB_PATH="$SCRATCH_DIR/db.sqlite3"

mkdir -p "$SCRATCH_DIR"
rm -f "$DB_PATH"
export DATABASE_URL="sqlite:///$DB_PATH"

cd "$REPO_ROOT"
source .venv/bin/activate
python -m alembic -c apps/api/alembic.ini upgrade head

python - <<'PY'
import os

from auth.hashing import hash_password
from models import Admin
from models.db import get_engine, get_sessionmaker

session_factory = get_sessionmaker(get_engine(os.environ["DATABASE_URL"]))
with session_factory() as session:
    session.add(Admin(password_hash=hash_password("e2e-test-password")))
    session.commit()
PY

cd "$SCRATCH_DIR"
exec uvicorn app.main:app --app-dir "$REPO_ROOT/apps/api" --host 127.0.0.1 --port 8199
