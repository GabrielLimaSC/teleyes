#!/bin/sh
set -e

# S23-01: starts as root only to fix volume ownership, then re-runs itself as `teleyes`.
[ "$(id -u)" = "0" ] && exec /as-teleyes.sh "$0" "$@"

# S19-03: entrypoint of the demo stack (docker-compose.demo.yml). /app/data is a
# tmpfs there, so every container start builds a fresh fictional database whose
# 90 days of history end "now". The seed runs the migrations itself and refuses
# any database that is not demo data.
mkdir -p /app/data

python scripts/seed_demo.py --db /app/data/teleyes.db

exec uvicorn app.main:app --host 0.0.0.0 --port 8000 --no-server-header
