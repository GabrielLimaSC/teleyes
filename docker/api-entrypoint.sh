#!/bin/sh
set -e

# S23-01: starts as root only to fix volume ownership, then re-runs itself as `teleyes`.
[ "$(id -u)" = "0" ] && exec /as-teleyes.sh "$0" "$@"

# /app/data is a named Docker volume (docker-compose.prod.yml), not a bind mount
# from the host filesystem — deliberately, so the permission tightening below is
# enforced by the filesystem Docker Desktop's own Linux VM actually uses, rather
# than depending on how the host OS's bind-mount driver maps POSIX permissions
# (on Windows/WSL2, a bind mount from an NTFS path does not enforce chmod at
# all — a named volume sidesteps that instead of silently assuming it works).
mkdir -p /app/data
chmod 700 /app/data
chmod 600 /app/data/teleyes.db /app/data/teleyes.session 2>/dev/null || true
# Self-host compose keeps the Telegram session in its own volume (S19-01); a no-op elsewhere.
chmod 700 /app/session 2>/dev/null || true
chmod 600 /app/session/teleyes.session /app/session/secrets.json 2>/dev/null || true

alembic -c apps/api/alembic.ini upgrade head

exec uvicorn app.main:app --host 0.0.0.0 --port 8000 --no-server-header
