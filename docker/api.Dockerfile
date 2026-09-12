# Shared production image for the FastAPI service (`api`) and the Telegram
# listener (`listener`, S5-09) — both are the same Python codebase and the
# same dependency set, so one image serves both; docker-compose.prod.yml
# picks which process runs by overriding `entrypoint:` per service. No
# --reload, no bind-mounted source, unlike Dockerfile.dev (root).
FROM python:3.12-slim

WORKDIR /app

ENV PYTHONUNBUFFERED=1

COPY pyproject.toml ./
COPY apps/api apps/api
COPY packages packages
COPY scripts scripts
# Editable install, not a built wheel: models/db.py anchors the default SQLite
# path to its own source file's grandparent-grandparent (repo root) via
# __file__ — a non-editable install copies that file into site-packages, which
# silently breaks the anchor and points the default DB path *inside the venv*
# instead of at the /app/data volume below. Same reason Dockerfile.dev (root)
# already installs with -e; production gets no benefit from a built wheel here
# since this image runs one single service, not something distributed.
RUN pip install --no-cache-dir -e .

COPY docker/api-entrypoint.sh /api-entrypoint.sh
COPY docker/listener-entrypoint.sh /listener-entrypoint.sh
RUN chmod +x /api-entrypoint.sh /listener-entrypoint.sh

EXPOSE 8000
ENTRYPOINT ["/api-entrypoint.sh"]
