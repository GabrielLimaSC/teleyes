#!/bin/sh
set -e

mkdir -p /app/backups
chmod 700 /app/backups

exec python scripts/run_backup.py
