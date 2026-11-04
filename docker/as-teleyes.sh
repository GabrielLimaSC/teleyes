#!/bin/sh
# S23-01: drop root before running anything of ours.
#
# Every entrypoint starts as root for one reason only: volumes created by an older image
# (which ran as root) hold root-owned files, and a named volume starts out root-owned.
# This script hands them to the unprivileged `teleyes` user, then re-executes the calling
# entrypoint as that user. Usage, as the first line of an entrypoint:
#
#   [ "$(id -u)" = "0" ] && exec /as-teleyes.sh "$0" "$@"
#
# Idempotent and cheap on a volume that is already right: only files with the wrong owner
# are touched. Without root (already unprivileged, e.g. `docker run --user`) it just runs.
set -e

if [ "$(id -u)" = "0" ]; then
    mkdir -p /app/data
    for dir in /app/data /app/session /app/backups; do
        [ -d "$dir" ] || continue
        find "$dir" ! -user teleyes -exec chown teleyes:teleyes {} +
    done
    exec setpriv --reuid=teleyes --regid=teleyes --clear-groups "$@"
fi

exec "$@"
