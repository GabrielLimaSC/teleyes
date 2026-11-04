#!/bin/sh
set -e

# S23-01: starts as root only to fix volume ownership, then re-runs itself as `teleyes`.
[ "$(id -u)" = "0" ] && exec /as-teleyes.sh "$0" "$@"

mkdir -p /app/backups
chmod 700 /app/backups

exec python scripts/run_backup.py
