#!/usr/bin/env bash
# teleyes self-host installer (S19-01). Run it from a clone of the repository:
#
#   ./install.sh                 interactive install (asks for the dashboard password)
#   ./install.sh --yes           non-interactive; password from $TELEYES_ADMIN_PASSWORD
#   ./install.sh --port 9090     publish the dashboard on 127.0.0.1:9090
#   ./install.sh --demo          fictional-data demo only (no Telegram, no secrets)
#   ./install.sh --uninstall     remove containers (volumes kept; add --purge to delete data)
#
# Safe to run again: it never overwrites an existing .env, never touches existing data and
# never changes the dashboard password without asking.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

PORT=""
ASSUME_YES=0
DEMO=0
UNINSTALL=0
PURGE=0
PASSWORD_MIN=8
ADMIN_PASSWORD=""

usage() {
  sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  echo "Options: --yes, --port N, --demo, --uninstall, --purge, --help"
}

say() { printf '%s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --yes | -y) ASSUME_YES=1 ;;
    --demo) DEMO=1 ;;
    --uninstall) UNINSTALL=1 ;;
    --purge) PURGE=1 ;;
    --port)
      [ "$#" -ge 2 ] || die "--port needs a value, e.g. --port 9090"
      PORT="$2"
      shift
      ;;
    --port=*) PORT="${1#--port=}" ;;
    --help | -h)
      usage
      exit 0
      ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
  shift
done

if [ -n "$PORT" ]; then
  case "$PORT" in
    '' | *[!0-9]*) die "--port must be a number between 1024 and 65535 (got '$PORT')" ;;
  esac
  { [ "$PORT" -ge 1024 ] && [ "$PORT" -le 65535 ]; } || die "--port must be between 1024 and 65535 (got '$PORT')"
fi
if [ "$PURGE" -eq 1 ] && [ "$UNINSTALL" -eq 0 ]; then
  die "--purge only makes sense together with --uninstall"
fi

# Compose file and project selection. COMPOSE_PROJECT_NAME, when set by the caller, wins
# over the `name:` in the file (that is how scripts/test_install.sh isolates itself).
if [ "$DEMO" -eq 1 ]; then
  COMPOSE_FILE_ARGS=(-f docker-compose.demo.yml)
else
  COMPOSE_FILE_ARGS=(-f docker-compose.yml)
fi
dc() { docker compose "${COMPOSE_FILE_ARGS[@]}" "$@"; }

confirm() { # confirm "question" -> 0 when the user agrees; --yes answers yes
  [ "$ASSUME_YES" -eq 1 ] && return 0
  [ -t 0 ] || die "need an interactive terminal to ask: $1 (use --yes to skip the question)"
  local answer
  read -r -p "$1 [y/N] " answer
  case "$answer" in y | Y | yes | YES) return 0 ;; *) return 1 ;; esac
}

check_docker() {
  step "Checking Docker"
  if ! command -v docker >/dev/null 2>&1; then
    die "Docker is not installed. Install Docker Desktop (macOS/Windows) or Docker Engine (Linux):
       https://docs.docker.com/get-docker/   -- on Windows use WSL2, see the README."
  fi
  if ! docker info >/dev/null 2>&1; then
    die "Docker is installed but the daemon is not running (or this user cannot reach it).
       Start Docker Desktop and wait until it says it is running, or on Linux run:
       sudo systemctl start docker   (and add your user to the 'docker' group)."
  fi
  if ! docker compose version >/dev/null 2>&1; then
    die "Docker Compose v2 is missing ('docker compose version' failed).
       Update Docker Desktop, or install the compose plugin: https://docs.docker.com/compose/install/"
  fi
  local mem_bytes
  mem_bytes="$(docker info --format '{{.MemTotal}}' 2>/dev/null || echo 0)"
  case "$mem_bytes" in '' | *[!0-9]*) mem_bytes=0 ;; esac
  if [ "$mem_bytes" -gt 0 ] && [ "$mem_bytes" -lt 1610612736 ]; then
    warn "Docker has less than 1.5 GB of memory; the web build may be killed (exit 137).
         Docker Desktop: Settings > Resources > Memory, raise it to 2 GB or more."
  fi
  say "Docker $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo ok), compose $(docker compose version --short 2>/dev/null || echo v2)"
}

port_in_use() { # true when something already listens on 127.0.0.1:$1
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
}

env_get() { # env_get KEY -> value from .env (empty when absent)
  [ -f .env ] || return 0
  sed -n "s/^$1=//p" .env | tail -n 1
}

env_set() { # env_set KEY VALUE -> replace the active line, or append
  local key="$1" value="$2" tmp
  tmp="$(mktemp)"
  if grep -q "^${key}=" .env 2>/dev/null; then
    awk -v k="$key" -v v="$value" 'index($0, k "=") == 1 { print k "=" v; next } { print }' .env >"$tmp"
  else
    cat .env >"$tmp"
    printf '%s=%s\n' "$key" "$value" >>"$tmp"
  fi
  cat "$tmp" >.env
  rm -f "$tmp"
}

detect_timezone() {
  local tz="${TZ:-}" link=""
  if [ -z "$tz" ] && [ -L /etc/localtime ]; then
    link="$(readlink /etc/localtime 2>/dev/null || true)"
    tz="${link#*zoneinfo/}"
  fi
  if [ -z "$tz" ] && [ -r /etc/timezone ]; then
    tz="$(head -n 1 /etc/timezone)"
  fi
  case "$tz" in
    [A-Za-z]*/[A-Za-z0-9_+/-]* | UTC) printf '%s' "$tz" ;;
    *) printf 'UTC' ;;
  esac
}

http_ok() { # http_ok URL -> 0 when it answers 2xx; with no curl/wget we trust compose --wait
  if command -v curl >/dev/null 2>&1; then
    curl -fsS -o /dev/null --max-time 5 "$1" 2>/dev/null
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O /dev/null -T 5 "$1" 2>/dev/null
  else
    return 0
  fi
}

wait_for_health() {
  local url="$1" tries=60
  while [ "$tries" -gt 0 ]; do
    if http_ok "$url"; then
      return 0
    fi
    tries=$((tries - 1))
    sleep 2
  done
  return 1
}

stack_running() { [ -n "$(dc ps -q 2>/dev/null)" ]; }

do_uninstall() {
  check_docker
  step "Uninstall"
  local down_args=(down --remove-orphans)
  if [ "$PURGE" -eq 1 ]; then
    say "--purge deletes the database, the Telegram session and the backups. This cannot be undone."
    confirm "Delete ALL teleyes data?" || {
      say "Aborted; nothing was removed."
      exit 0
    }
    down_args+=(-v)
  else
    confirm "Stop and remove the teleyes containers? (data volumes are kept)" || {
      say "Aborted; nothing was removed."
      exit 0
    }
  fi
  dc "${down_args[@]}"
  if [ "$PURGE" -eq 1 ]; then
    say "Containers and data removed. Your .env file was kept; delete it yourself if you want."
  else
    say "Containers removed. Data volumes kept: run ./install.sh again to bring everything back,"
    say "or ./install.sh --uninstall --purge to delete the data too."
  fi
}

do_demo() {
  check_docker
  local demo_port="${PORT:-18080}"
  step "Starting the demo (fictional data, nothing is sent anywhere)"
  if ! stack_running && port_in_use "$demo_port"; then
    die "Port $demo_port is already in use. Pick another one: ./install.sh --demo --port 18081"
  fi
  TELEYES_DEMO_PORT="$demo_port" dc up -d --build --wait --wait-timeout 300
  wait_for_health "http://127.0.0.1:${demo_port}/health" ||
    die "The demo did not become healthy; see: docker compose -f docker-compose.demo.yml logs"
  step "Demo is up"
  say "Open http://127.0.0.1:${demo_port}   password: demo-teleyes"
  say "Stop it with: ./install.sh --demo --uninstall"
}

ask_password() { # sets ADMIN_PASSWORD (never echoed, never in argv)
  local confirm_pw
  if [ -n "${TELEYES_ADMIN_PASSWORD:-}" ]; then
    ADMIN_PASSWORD="$TELEYES_ADMIN_PASSWORD"
  elif [ "$ASSUME_YES" -eq 1 ]; then
    die "--yes needs the dashboard password in the TELEYES_ADMIN_PASSWORD environment variable."
  else
    [ -t 0 ] || die "no terminal to ask for the password. Run it in a terminal, or use --yes with TELEYES_ADMIN_PASSWORD."
    while true; do
      read -r -s -p "Choose a dashboard password (min ${PASSWORD_MIN} characters): " ADMIN_PASSWORD
      printf '\n'
      read -r -s -p "Repeat the password: " confirm_pw
      printf '\n'
      if [ "${#ADMIN_PASSWORD}" -lt "$PASSWORD_MIN" ]; then
        say "Too short; use at least ${PASSWORD_MIN} characters."
      elif [ "$ADMIN_PASSWORD" != "$confirm_pw" ]; then
        say "The two passwords differ; try again."
      else
        break
      fi
    done
  fi
  [ "${#ADMIN_PASSWORD}" -ge "$PASSWORD_MIN" ] || die "the password needs at least ${PASSWORD_MIN} characters."
}

set_admin_password() {
  # Reuses scripts/create_admin.py inside the api container: only the Argon2 hash is
  # stored. The password reaches it through the environment, never through argv.
  TELEYES_ADMIN_PASSWORD="$ADMIN_PASSWORD" dc exec -T -e TELEYES_ADMIN_PASSWORD api python scripts/create_admin.py >/dev/null
}

setup_admin() {
  step "Dashboard password"
  local rc=0
  dc exec -T api python scripts/create_admin.py --check || rc=$?
  if [ "$rc" -eq 0 ]; then
    say "A dashboard password is already set; leaving it alone."
    if [ "$ASSUME_YES" -eq 0 ] && [ -t 0 ] && confirm "Change it now?"; then
      ask_password
      set_admin_password
      say "Password changed."
    else
      say "To change it later: docker compose exec api python scripts/create_admin.py"
    fi
  elif [ "$rc" -eq 3 ]; then
    ask_password
    set_admin_password
    say "Password set (only its Argon2 hash is stored)."
  else
    die "could not check the admin account (exit $rc); see: docker compose logs api"
  fi
  ADMIN_PASSWORD=""
}

do_install() {
  # Fail fast, before a long build, when a non-interactive run lacks its password.
  if [ "$ASSUME_YES" -eq 1 ] && [ -z "${TELEYES_ADMIN_PASSWORD:-}" ]; then
    die "--yes needs the dashboard password in the TELEYES_ADMIN_PASSWORD environment variable."
  fi
  check_docker

  step "Configuration (.env)"
  if [ -f .env ]; then
    say ".env already exists; keeping your values."
  else
    [ -f .env.example ] || die ".env.example not found; run this from the root of the teleyes repository."
    cp .env.example .env
    say "Created .env from .env.example."
    env_set DISPLAY_TIMEZONE "$(detect_timezone)"
    # Plain http on 127.0.0.1: Safari drops Secure cookies there. Set it back to true
    # when you put HTTPS in front (see the README).
    env_set SESSION_COOKIE_SECURE false
  fi
  chmod 600 .env
  if [ -n "$PORT" ]; then
    env_set TELEYES_PORT "$PORT"
  fi
  PORT="$(env_get TELEYES_PORT)"
  PORT="${PORT:-8080}"
  say "Dashboard port: $PORT   Timezone: $(env_get DISPLAY_TIMEZONE)"

  step "Checking the port"
  if ! stack_running && port_in_use "$PORT"; then
    die "Port $PORT is already in use by another program.
       Pick a free one: ./install.sh --port 9090   (or stop whatever uses $PORT)."
  fi

  step "Building and starting the stack (the first run takes a few minutes)"
  dc up -d --build --wait --wait-timeout 600
  wait_for_health "http://127.0.0.1:${PORT}/health" ||
    die "The dashboard did not answer on port $PORT; see: docker compose logs api web"

  setup_admin

  # S19-02 HOOK: the guided Telegram wizard plugs in here. It will ask for api_id /
  # api_hash / bot token, write them to .env, run scripts/telegram_login.py and restart
  # the listener. Until then we only print the exact manual steps below.
  step "teleyes is running"
  cat <<EOM
Dashboard:  http://127.0.0.1:${PORT}    (log in with the password you chose)

The monitor starts in the "not_configured" state: the dashboard works, but nothing is
read from Telegram until you connect it. Next steps (about 5 minutes):

  1. Get your Telegram API credentials at https://my.telegram.org/apps and a bot token
     from @BotFather, then paste them into: $(pwd)/.env
        TG_API_ID=...   TG_API_HASH=...   BOT_TOKEN=...
  2. Log the reading session in (it asks for your phone, the code and your 2FA password):
        docker compose run --rm --entrypoint python listener scripts/telegram_login.py
  3. Apply it:
        docker compose up -d
  4. In the dashboard add a source group, a recipient (send /start to your bot first) and
     a rule, then click "Aplicar regras".

Logs: docker compose logs -f     Update: git pull && docker compose up -d --build
Uninstall: ./install.sh --uninstall
EOM
}

if [ "$UNINSTALL" -eq 1 ]; then
  do_uninstall
elif [ "$DEMO" -eq 1 ]; then
  do_demo
else
  do_install
fi
