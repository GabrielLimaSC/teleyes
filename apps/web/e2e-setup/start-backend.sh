#!/usr/bin/env bash
# S19-02: starts the REAL api with a FAKE Telegram and bot (e2e_setup_app.py) on 127.0.0.1:8199,
# over a fresh scratch SQLite database, session directory and secrets file, with one seeded
# admin. No Telegram credentials exist, nothing here can reach the network.
set -euo pipefail

WEB_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "$WEB_DIR/../.." && pwd)"
SCRATCH_DIR="$WEB_DIR/e2e-setup/.scratch"

rm -rf "$SCRATCH_DIR"
mkdir -p "$SCRATCH_DIR"
export DATABASE_URL="sqlite:///$SCRATCH_DIR/db.sqlite3"
export TELEYES_SESSION_PATH="$SCRATCH_DIR/session/teleyes.session"
export TG_API_ID="" TG_API_HASH="" BOT_TOKEN="" TELEYES_SECRETS_PATH="" TELEYES_DEMO=""

cd "$REPO_ROOT"
source .venv/bin/activate
export PYTHONPATH="$REPO_ROOT/apps/api:$REPO_ROOT:$WEB_DIR/e2e-setup"
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
exec uvicorn e2e_setup_app:app --app-dir "$WEB_DIR/e2e-setup" --host 127.0.0.1 --port 8199
