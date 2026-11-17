#!/bin/sh
# The only way to run `docker compose` on the production application stack (ADR 067; ADR 052).
#
# Production has run on Supabase since 2026-11-12. The Supabase overlay and its env file must be on
# EVERY command: without them `up` recreates the API against the old local PostgreSQL (wrong
# database, missing data). This wrapper always adds them, in the order production uses, and refuses
# to run when any of them is missing. It lives in /opt/hrvo-livekit (not in the app checkout), so it
# is still there after a rollback checks out an older commit.
#
#   /opt/hrvo-livekit/prod-compose.sh up -d --no-deps api
#   /opt/hrvo-livekit/prod-compose.sh ps
#   /opt/hrvo-livekit/prod-compose.sh --print up -d --no-deps api   # show the command, run nothing
#
# Refused: `config` without -q/--quiet (it prints every secret), `down` (stops production; set
# HRVO_ALLOW_DOWN=1 deliberately). Settings: APP_DIR (default /opt/virtual-hr/app), DOCKER_CMD
# (default `docker` as root, `sudo -n docker` otherwise; the tests use a stub).
set -eu
APP_DIR=${APP_DIR:-/opt/virtual-hr/app}
# Later files override earlier ones: the Supabase overlay must come last.
FILES="docker-compose.staging.yml docker-compose.staging.ssh.yml docker-compose.staging.https.yml docker-compose.staging.supabase.yml"
ENVS=".env.staging .env.staging.db .env.staging.supabase"

die() { echo "prod-compose: $*" >&2; exit 1; }

print=0
if [ "${1:-}" = "--print" ]; then print=1; shift; fi
[ $# -gt 0 ] || [ "$print" = 1 ] || die "no compose command given (e.g. ps, up -d --no-deps api)"

cd "$APP_DIR" 2>/dev/null || die "$APP_DIR does not exist"
for f in $FILES; do
  [ -f "$f" ] || die "$APP_DIR/$f is missing: refusing to run without the production overlays"
done
for e in $ENVS; do
  [ -f "$e" ] || die "$APP_DIR/$e is missing: refusing to run without the production env files"
  case "$(stat -c %a "$e")" in *00) ;; *) die "$APP_DIR/$e is readable by group or others (expected mode 600)";; esac
done
# The overlay still points the API at Supabase, and the Supabase env file names a host (names only;
# no value is printed).
grep -q 'SUPABASE_PGHOST' docker-compose.staging.supabase.yml || die "docker-compose.staging.supabase.yml no longer sets PGHOST from SUPABASE_PGHOST"
grep -qE '^SUPABASE_PGHOST=.+' .env.staging.supabase || die ".env.staging.supabase has no SUPABASE_PGHOST"

# The compose subcommand: the first argument that is not an option.
sub=""
for a in "$@"; do case "$a" in -*) ;; *) sub=$a; break;; esac; done
case "$sub" in
  config)
    quiet=0
    for a in "$@"; do case "$a" in -q|--quiet) quiet=1;; esac; done
    [ "$quiet" = 1 ] || die "'config' prints every secret; use 'config -q' (validation only)"
    ;;
  down)
    [ "${HRVO_ALLOW_DOWN:-}" = 1 ] || die "'down' stops production; set HRVO_ALLOW_DOWN=1 if that is really intended"
    ;;
esac

if [ -n "${DOCKER_CMD:-}" ]; then docker_cmd=$DOCKER_CMD
elif [ "$(id -u)" = 0 ]; then docker_cmd=docker
else docker_cmd="sudo -n docker"
fi

set -- compose \
  -f docker-compose.staging.yml -f docker-compose.staging.ssh.yml \
  -f docker-compose.staging.https.yml -f docker-compose.staging.supabase.yml \
  --env-file .env.staging --env-file .env.staging.db --env-file .env.staging.supabase "$@"

if [ "$print" = 1 ]; then
  echo "cd $APP_DIR && $docker_cmd $*"
  exit 0
fi
# shellcheck disable=SC2086 # docker_cmd may be "sudo -n docker"
exec $docker_cmd "$@"
