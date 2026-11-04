# Shared production image for the FastAPI service (`api`), the Telegram
# listener (`listener`, S5-09), and the backup sidecar (`backup`, S5-03) —
# all three are the same Python codebase and the same dependency set, so one
# image serves all of them; docker-compose.prod.yml picks which process runs
# by overriding `entrypoint:` per service (docker-compose.demo.yml, S19-03, runs it
# with /demo-entrypoint.sh: a fictional database and no listener). No --reload, no bind-mounted
# source, unlike Dockerfile.dev (root). Runs as the unprivileged `teleyes` user (S23-01).
FROM python:3.12-slim

# S23-01: pick up Debian security fixes published after the base image was built.
RUN apt-get update \
    && apt-get upgrade -y --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV PYTHONUNBUFFERED=1

COPY pyproject.toml ./
COPY apps/api apps/api
COPY core core
COPY packages packages
COPY scripts scripts
# Editable install, not a built wheel: models/db.py anchors the default SQLite
# path to its own source file's grandparent-grandparent (repo root) via
# __file__ — a non-editable install copies that file into site-packages, which
# silently breaks the anchor and points the default DB path *inside the venv*
# instead of at the /app/data volume below. Same reason Dockerfile.dev (root)
# already installs with -e; production gets no benefit from a built wheel here
# since this image runs one single service, not something distributed.
RUN pip install --no-cache-dir -e ./core -e .

COPY docker/api-entrypoint.sh /api-entrypoint.sh
COPY docker/listener-entrypoint.sh /listener-entrypoint.sh
COPY docker/backup-entrypoint.sh /backup-entrypoint.sh
COPY docker/demo-entrypoint.sh /demo-entrypoint.sh
COPY docker/as-teleyes.sh /as-teleyes.sh
RUN chmod +x /api-entrypoint.sh /listener-entrypoint.sh /backup-entrypoint.sh /demo-entrypoint.sh /as-teleyes.sh

# S23-01: nothing of ours runs as root. The entrypoints start as root only to hand the
# volumes to this user (docker/as-teleyes.sh) and then drop to it.
RUN useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin teleyes

EXPOSE 8000
ENTRYPOINT ["/api-entrypoint.sh"]
