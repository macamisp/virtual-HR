#!/bin/sh
# The only way to run `docker compose` on the production application stack (ADR 067; ADR 052).
#
# Production has run on Supabase since 2026-11-12. The HTTPS and Supabase overlays and their env
# files must be on EVERY command: without them `up` recreates the API against the old local
# PostgreSQL. This wrapper always adds them, in the order production uses, and refuses to run when
# any of them is missing. It lives in /opt/hrvo-livekit (not in the app checkout), so it is still
# there after a rollback checks out an older commit.
#
# Allow-list (everything else, including any option before the subcommand, is refused):
#   ps [-a|--all] [-q|--quiet] [--services]
#   images [-q|--quiet]
#   logs [-f|--follow] [-t|--timestamps] [--no-color] [--tail N] [--since T] [--until T] [SERVICE...]
#   build [--pull] [--no-cache] SERVICE...                       SERVICE: api, web
#   up (-d|--detach) --no-deps [--no-build] [--wait] SERVICE...  SERVICE: api, web (named, at least one)
#   config (-q|--quiet)                                          validation only
#   version
# Refused by design: config/convert with output (they print every secret), down, stop, kill, rm,
# restart, exec, run, cp, create, start, pause, scale, watch, events, global options such as
# -f, --env-file, -p, --profile, --project-directory, --ansi, --dry-run (they change the project,
# its services or what is printed), and `--`. Inherited COMPOSE_* and DOCKER_* variables are
# cleared. Other operations need a reviewed change to this file.
#
#   /opt/hrvo-livekit/prod-compose.sh up -d --no-deps api
#   /opt/hrvo-livekit/prod-compose.sh --print up -d --no-deps api   # show the command, run nothing
#
# Settings: APP_DIR (default /opt/virtual-hr/app); DOCKER_CMD (default `docker` as root, `sudo -n
# docker` otherwise; the tests use a stub).
set -eu
APP_DIR=${APP_DIR:-/opt/virtual-hr/app}
FILES="docker-compose.staging.yml docker-compose.staging.ssh.yml docker-compose.staging.https.yml docker-compose.staging.supabase.yml"
ENVS=".env.staging .env.staging.db .env.staging.supabase"
RECREATE_SERVICES="api web"
LOG_SERVICES="api web proxy storage clamav redis postgres"

die() { echo "prod-compose: $*" >&2; exit 1; }
in_list() { _w=$1; shift; for _x in "$@"; do [ "$_x" = "$_w" ] && return 0; done; return 1; }
# A word that is safe as a value: no spaces, quotes, shell or option syntax.
plain() { case "$1" in ''|-*|*[!A-Za-z0-9._:+-]*) return 1;; esac; return 0; }

print=0
if [ "${1:-}" = "--print" ]; then print=1; shift; fi
[ $# -gt 0 ] || die "no compose command given (e.g. ps, up -d --no-deps api)"

# --- the arguments: subcommand first, then only that subcommand's allowed flags ------------------
# (A function, so its shifts leave the command line itself intact.)
validate() {
sub=$1; shift
case "$sub" in
  -*) die "options before the subcommand are not allowed ('$sub'): the wrapper sets the files, env files and project" ;;
esac
services=""
case "$sub" in
  ps)
    for a in "$@"; do
      case "$a" in -a|--all|-q|--quiet|--services) ;; *) die "ps: '$a' is not allowed";; esac
    done ;;
  images)
    for a in "$@"; do
      case "$a" in -q|--quiet) ;; *) die "images: '$a' is not allowed";; esac
    done ;;
  version)
    [ $# -eq 0 ] || die "version takes no arguments" ;;
  logs)
    while [ $# -gt 0 ]; do
      case "$1" in
        -f|--follow|-t|--timestamps|--no-color) ;;
        --tail|--since|--until)
          [ $# -ge 2 ] || die "logs: $1 needs a value"
          plain "$2" || die "logs: '$2' is not a valid value for $1"; shift ;;
        --tail=*|--since=*|--until=*)
          plain "${1#*=}" || die "logs: '$1' has an invalid value" ;;
        -*) die "logs: '$1' is not allowed" ;;
        *) in_list "$1" $LOG_SERVICES || die "logs: unknown service '$1'"; services="$services $1" ;;
      esac
      shift
    done ;;
  build)
    for a in "$@"; do
      case "$a" in
        --pull|--no-cache) ;;
        -*) die "build: '$a' is not allowed" ;;
        *) in_list "$a" $RECREATE_SERVICES || die "build: only $RECREATE_SERVICES may be built here, not '$a'"; services="$services $a" ;;
      esac
    done
    [ -n "$services" ] || die "build: name the services (api, web)" ;;
  up)
    detach=0; nodeps=0
    for a in "$@"; do
      case "$a" in
        -d|--detach) detach=1 ;;
        --no-deps) nodeps=1 ;;
        --no-build|--wait) ;;
        -*) die "up: '$a' is not allowed (only -d/--detach, --no-deps, --no-build, --wait)" ;;
        *) in_list "$a" $RECREATE_SERVICES || die "up: only $RECREATE_SERVICES may be recreated here, not '$a'"; services="$services $a" ;;
      esac
    done
    [ "$detach" = 1 ] || die "up: -d is required (a foreground up stops the services on Ctrl-C)"
    [ "$nodeps" = 1 ] || die "up: --no-deps is required (never recreate the databases, storage or scanner as a side effect)"
    [ -n "$services" ] || die "up: name the services to recreate (api, web)" ;;
  config)
    [ $# -eq 1 ] && { [ "$1" = -q ] || [ "$1" = --quiet ]; } \
      || die "config: only 'config -q' is allowed (any other form prints every secret)" ;;
  convert)
    die "'convert' is an alias of config and prints every secret" ;;
  down|stop|kill|rm|restart|exec|run|cp|create|start|pause|unpause|scale|watch|events|attach|publish|commit|export|wait|alpha|bridge|stats|top|port|ls|volumes|pull|push)
    die "'$sub' is not allowed through this wrapper (it could stop, change or expose production)" ;;
  *)
    die "unknown compose command '$sub'" ;;
esac
}
validate "$@"

# --- the production files ------------------------------------------------------------------------
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

# Nothing from the caller's environment may change the project, its files, profiles or daemon.
for v in $(env | sed -n 's/^\(COMPOSE_[A-Za-z0-9_]*\)=.*/\1/p; s/^\(DOCKER_HOST\|DOCKER_CONTEXT\|DOCKER_CONFIG\|DOCKER_TLS_VERIFY\|DOCKER_CERT_PATH\)=.*/\1/p'); do
  unset "$v"
done

if [ -n "${DOCKER_CMD:-}" ]; then docker_cmd=$DOCKER_CMD
elif [ "$(id -u)" = 0 ]; then docker_cmd=docker
else docker_cmd="sudo -n docker"
fi

set -- compose \
  -f docker-compose.staging.yml -f docker-compose.staging.ssh.yml \
  -f docker-compose.staging.https.yml -f docker-compose.staging.supabase.yml \
  --env-file .env.staging --env-file .env.staging.db --env-file .env.staging.supabase \
  "$@"

if [ "$print" = 1 ]; then
  echo "cd $APP_DIR && $docker_cmd $*"
  exit 0
fi
# shellcheck disable=SC2086 # docker_cmd may be "sudo -n docker"
exec $docker_cmd "$@"
