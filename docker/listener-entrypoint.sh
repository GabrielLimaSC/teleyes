#!/bin/sh
set -e

# Same permission tightening as docker/api-entrypoint.sh, and just as
# idempotent/safe to repeat here — see that file for why a named volume
# instead of a bind mount. No `alembic upgrade head` here on purpose:
# docker-compose.prod.yml's `depends_on: api: condition: service_healthy`
# guarantees the `api` service (whose own entrypoint runs the migration)
# is already up before this container starts, so exactly one process ever
# runs a migration — two containers racing `alembic upgrade head` against
# the same SQLite file at once would be a real, not theoretical, problem.
mkdir -p /app/data
chmod 700 /app/data
chmod 600 /app/data/teleyes.db /app/data/teleyes.session 2>/dev/null || true

exec python scripts/run_listener.py
