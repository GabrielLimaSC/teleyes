# Production image for the FastAPI service. Separate from Dockerfile.dev (root):
# no --reload, no bind-mounted source, migrations run automatically before the
# server starts instead of being a manual step someone has to remember.
FROM python:3.12-slim

WORKDIR /app

ENV PYTHONUNBUFFERED=1

COPY pyproject.toml ./
COPY apps/api apps/api
COPY packages packages
# Editable install, not a built wheel: models/db.py anchors the default SQLite
# path to its own source file's grandparent-grandparent (repo root) via
# __file__ — a non-editable install copies that file into site-packages, which
# silently breaks the anchor and points the default DB path *inside the venv*
# instead of at the /app/data volume below. Same reason Dockerfile.dev (root)
# already installs with -e; production gets no benefit from a built wheel here
# since this image runs one single service, not something distributed.
RUN pip install --no-cache-dir -e .

COPY docker/api-entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8000
ENTRYPOINT ["/entrypoint.sh"]
