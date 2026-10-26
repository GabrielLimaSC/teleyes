#!/usr/bin/env bash
# End-to-end test of install.sh (S19-01). Heavy (builds the images), so it is not part of
# CI; run it by hand before changing install.sh or docker-compose.yml:
#
#   scripts/test_install.sh                 # port 18090
#   TEST_PORT=18123 scripts/test_install.sh
#
# Isolation: a throw-away copy of the working tree in a temp dir, its own Compose project
# (teleyes-install-test), its own port. `down -v` runs only for that project. It never
# touches any other project, container or volume on the machine.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT="teleyes-install-test"
PORT="${TEST_PORT:-18090}"
BASE="http://127.0.0.1:${PORT}"

export COMPOSE_PROJECT_NAME="$PROJECT"
case "$COMPOSE_PROJECT_NAME" in
  teleyes-dev* | teleyes) echo "refusing to run against a real project name" >&2; exit 2 ;;
esac

WORKDIR="$(mktemp -d)"
FAILS=0
PASS_OK="$(python3 -c 'import secrets; print(secrets.token_urlsafe(18))')"
PASS_OTHER="$(python3 -c 'import secrets; print(secrets.token_urlsafe(18))')"

cleanup() {
  if [ -d "$WORKDIR/teleyes" ]; then
    (cd "$WORKDIR/teleyes" && docker compose down -v --remove-orphans >/dev/null 2>&1) || true
  fi
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

ok() { printf '  ok    %s\n' "$1"; }
bad() {
  printf '  FAIL  %s\n' "$1"
  FAILS=$((FAILS + 1))
}
check() { # check "description" command...
  local what="$1"
  shift
  if "$@" >/dev/null 2>&1; then ok "$what"; else bad "$what"; fi
}

login_status() { # login_status PASSWORD -> HTTP status; the password goes via stdin, not argv
  P="$1" python3 -c 'import json, os; print(json.dumps({"password": os.environ["P"]}))' |
    curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
      --data-binary @- "$BASE/auth/login"
}

login_cookie_header() { # prints the Set-Cookie header of a successful login
  P="$1" python3 -c 'import json, os; print(json.dumps({"password": os.environ["P"]}))' |
    curl -s -D - -o /dev/null -X POST -H 'Content-Type: application/json' \
      --data-binary @- "$BASE/auth/login" | grep -i '^set-cookie:' || true
}

service_state() { # service_state NAME -> health/state of the compose service
  local id
  id="$(docker compose ps -q "$1" 2>/dev/null)"
  [ -n "$id" ] || {
    echo missing
    return
  }
  docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id"
}

echo "== preparing a clean copy of the working tree in $WORKDIR/teleyes"
mkdir -p "$WORKDIR/teleyes"
(cd "$REPO_ROOT" && git ls-files -co --exclude-standard -z | tar --null -T - -cf -) | tar -xf - -C "$WORKDIR/teleyes"
cd "$WORKDIR/teleyes"
[ ! -e .env ] || {
  echo "the copy must not contain a .env" >&2
  exit 2
}

echo "== 1. first install (--yes, port $PORT)"
TELEYES_ADMIN_PASSWORD="$PASS_OK" ./install.sh --yes --port "$PORT" >install-1.log 2>&1 || {
  tail -n 40 install-1.log
  bad "first install exited non-zero"
}
check ".env was created" test -f .env
check ".env is private (600)" test "$(stat -c '%a' .env 2>/dev/null || stat -f '%Lp' .env)" = "600"
check ".env has the chosen port" grep -q "^TELEYES_PORT=${PORT}$" .env
check ".env has no Telegram credentials" grep -q '^TG_API_HASH=$' .env
check "GET /health answers 200" curl -fsS -o /dev/null "$BASE/health"
check "api is healthy" test "$(service_state api)" = healthy
check "web is healthy" test "$(service_state web)" = healthy
check "listener is running (not_configured, not crashed)" test "$(service_state listener)" = running
check "backup is running" test "$(service_state backup)" = running
check "login works with the chosen password" test "$(login_status "$PASS_OK")" = 200
check "login refuses a wrong password" test "$(login_status "${PASS_OK}x")" = 401
cookie="$(login_cookie_header "$PASS_OK")"
check "session cookie is HttpOnly" grep -qi 'httponly' <<<"$cookie"
not_secure() { ! grep -qi 'secure' <<<"$cookie"; }
log_lacks_password() { ! grep -q -F "$PASS_OK" install-1.log; }
check "session cookie is not Secure on plain http" not_secure
check "the password never reached the install log" log_lacks_password
check "volumes exist (data, session, backups)" test "$(docker volume ls -q --filter "label=com.docker.compose.project=$PROJECT" | wc -l | tr -d ' ')" = 3

echo "== 2. second run is idempotent"
env_before="$(shasum .env | cut -d' ' -f1)"
TELEYES_ADMIN_PASSWORD="$PASS_OTHER" ./install.sh --yes >install-2.log 2>&1 || {
  tail -n 40 install-2.log
  bad "second install exited non-zero"
}
check ".env untouched" test "$(shasum .env | cut -d' ' -f1)" = "$env_before"
check "same port kept without --port" grep -q "^TELEYES_PORT=${PORT}$" .env
check "original password still works" test "$(login_status "$PASS_OK")" = 200
check "a different env password did NOT replace it" test "$(login_status "$PASS_OTHER")" = 401
check "api still healthy" test "$(service_state api)" = healthy

echo "== 3. --uninstall keeps the data, --uninstall --purge deletes it"
./install.sh --uninstall --yes >uninstall-1.log 2>&1 || bad "uninstall exited non-zero"
check "containers are gone" test -z "$(docker compose ps -aq)"
check "volumes survive a plain uninstall" test "$(docker volume ls -q --filter "label=com.docker.compose.project=$PROJECT" | wc -l | tr -d ' ')" = 3
TELEYES_ADMIN_PASSWORD="$PASS_OTHER" ./install.sh --yes >install-3.log 2>&1 || bad "reinstall exited non-zero"
check "reinstall finds the old password (data survived)" test "$(login_status "$PASS_OK")" = 200
./install.sh --uninstall --purge --yes >uninstall-2.log 2>&1 || bad "purge exited non-zero"
check "containers gone after purge" test -z "$(docker compose ps -aq)"
check "volumes gone after purge" test -z "$(docker volume ls -q --filter "label=com.docker.compose.project=$PROJECT")"
check ".env kept after purge" test -f .env

echo
if [ "$FAILS" -eq 0 ]; then
  echo "ALL CHECKS PASSED"
else
  echo "$FAILS CHECK(S) FAILED"
  exit 1
fi
