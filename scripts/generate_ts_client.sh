#!/usr/bin/env bash
# Regenerate the typed API contract for the frontend: exports the FastAPI
# OpenAPI schema and runs it through openapi-typescript to produce plain
# TypeScript types (no frontend app consumes this yet — that's Sprint 4).
#
# Usage:
#   ./scripts/generate_ts_client.sh
#
# Requires: the project venv active (for the Python export step) and Node.js
# (openapi-typescript runs via `npx`, no local install needed).
set -euo pipefail

cd "$(dirname "$0")/.."

python scripts/export_openapi.py
npx --yes openapi-typescript@7 contracts/openapi.json -o contracts/api-types.ts

echo "Contrato regenerado: contracts/openapi.json e contracts/api-types.ts"
