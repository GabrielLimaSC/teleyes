#!/usr/bin/env bash
# S27-05: regenerates the README media (docs/screenshots/*.png and docs/media/demo.gif)
# from the fictional-data demo stack. Never touches a real database or stack.
#
# Needs: Docker, Node with `npm ci` done in apps/web and Playwright chromium installed, ffmpeg.
# Usage: scripts/record_readme_media.sh
# Optional env: DEMO_PORT (default 18091), KEEP_STACK=1 to leave the stack running.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WEB="$ROOT/apps/web"
PORT="${DEMO_PORT:-18091}"
PROJECT="teleyes-shots"
COMPOSE=(docker compose -p "$PROJECT" -f "$ROOT/docker-compose.demo.yml")
VIDEO_DIR="$WEB/e2e-demo/.scratch/readme-gif"
GIF="$ROOT/docs/media/demo.gif"
FPS=10
WIDTH=800

command -v ffmpeg >/dev/null || { echo "ffmpeg not found" >&2; exit 1; }
command -v docker >/dev/null || { echo "docker not found" >&2; exit 1; }

cleanup() {
  if [ "${KEEP_STACK:-0}" != "1" ]; then
    TELEYES_DEMO_PORT="$PORT" "${COMPOSE[@]}" down >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

echo "==> demo stack on 127.0.0.1:$PORT (project $PROJECT)"
TELEYES_DEMO_PORT="$PORT" "${COMPOSE[@]}" up --build -d
for _ in $(seq 1 60); do
  curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break
  sleep 2
done
curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null

export DEMO_BASE_URL="http://127.0.0.1:$PORT"
cd "$WEB"

echo "==> screenshots"
SCREENSHOTS=1 npx playwright test -c playwright.demo.config.ts e2e-demo/screenshots.spec.ts

echo "==> tour recording"
README_GIF=1 GIF_VIDEO_DIR="$VIDEO_DIR" npx playwright test -c playwright.demo.config.ts e2e-demo/readme-gif.spec.ts

echo "==> GIF"
PALETTE="$VIDEO_DIR/palette.png"
FILTERS="fps=$FPS,scale=$WIDTH:-1:flags=lanczos"
ffmpeg -y -loglevel error -i "$VIDEO_DIR/tour.webm" -vf "$FILTERS,palettegen=max_colors=64:stats_mode=diff" "$PALETTE"
ffmpeg -y -loglevel error -i "$VIDEO_DIR/tour.webm" -i "$PALETTE" \
  -lavfi "$FILTERS [x]; [x][1:v] paletteuse=dither=none:diff_mode=rectangle" -loop 0 "$GIF"

ls -l "$GIF"
