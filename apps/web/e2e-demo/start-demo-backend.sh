#!/usr/bin/env bash
# S19-03: a real FastAPI backend in demo mode for the demo Playwright spec: a fresh
# scratch SQLite DB seeded by scripts/seed_demo.py, read-only guard on, no live
# replayer (so nothing changes under the test), no Telegram/bot credentials.
set -euo pipefail

WEB_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "$WEB_DIR/../.." && pwd)"
SCRATCH_DIR="$WEB_DIR/e2e-demo/.scratch"
DB_PATH="$SCRATCH_DIR/demo.db"

mkdir -p "$SCRATCH_DIR"
rm -f "$DB_PATH" "$DB_PATH-shm" "$DB_PATH-wal"

cd "$REPO_ROOT"
source .venv/bin/activate
# The venv's editable install may point at another checkout: use this one.
export PYTHONPATH="$REPO_ROOT/apps/api:$REPO_ROOT"

python scripts/seed_demo.py --db "$DB_PATH"

export DATABASE_URL="sqlite:///$DB_PATH"
export TELEYES_DEMO=1
export TELEYES_DEMO_READONLY=1
export TELEYES_DEMO_LIVE=0

cd "$SCRATCH_DIR"
exec uvicorn app.main:app --app-dir "$REPO_ROOT/apps/api" --host 127.0.0.1 --port 8198
