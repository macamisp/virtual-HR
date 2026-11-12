#!/usr/bin/env bash
# Daily encrypted logical backup of the Supabase database (ADR 052, NFR-REL-002). Runs on the OPERATOR
# WORKSTATION, never on EC2: the Supabase admin login stays in the private env file here. pg_dump 17
# (podman) streams straight into gpg (public key only), so plaintext never touches disk. Prints no secrets.
#
#   RECIPIENT_FPR=<40-hex> bash scripts/supabase-backup.sh [env-file] [out-dir]
#   restore: gpg -d <file>.dump.gpg | pg_restore --list   (private key needed; keep it offline)
set -euo pipefail
ENV_FILE=${1:-/run/media/macami/DataDrive/hrvo-secrets/supabase-sydney/supabase.env}
OUT=${2:-/run/media/macami/DataDrive/hrvo-backups/supabase}
KEEP_DAYS=${KEEP_DAYS:-14}
IMAGE=${PG_IMAGE:-docker.io/library/postgres:17-alpine}
: "${RECIPIENT_FPR:?set RECIPIENT_FPR to the backup encryption key fingerprint}"
[[ $RECIPIENT_FPR =~ ^[0-9A-F]{40}$ ]] || { echo "RECIPIENT_FPR must be 40 upper-case hex" >&2; exit 2; }
[ "$(stat -c %a "$ENV_FILE")" = 600 ] || { echo "$ENV_FILE must be mode 600" >&2; exit 2; }
gpg --batch --with-colons --list-keys "$RECIPIENT_FPR" 2>/dev/null | awk -F: '$1=="pub"||$1=="sub"{if($12~/[eE]/)ok=1} END{exit !ok}' \
  || { echo "no usable encryption key for $RECIPIENT_FPR in the keyring" >&2; exit 3; }

val() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -1 | sed -E "s/^(['\"])(.*)\1$/\2/"; }
HOST=$(val SUPABASE_PGHOST); USER_=$(val SUPABASE_ADMIN_USER); CA=$(val SUPABASE_CA_FILE)
[ -n "$HOST" ] && [ -n "$USER_" ] && [ -f "$CA" ] || { echo "SUPABASE_PGHOST / SUPABASE_ADMIN_USER / SUPABASE_CA_FILE missing" >&2; exit 2; }

umask 077; mkdir -p "$OUT"
STAMP=$(date -u +%Y%m%dT%H%M%SZ); F="$OUT/supabase-$STAMP.dump.gpg"
PGPASSWORD=$(val SUPABASE_ADMIN_PASSWORD) podman run --rm -i -e PGPASSWORD \
    -e PGSSLMODE=verify-full -e PGSSLROOTCERT=/ca.crt -v "$CA:/ca.crt:ro,Z" "$IMAGE" \
    pg_dump -h "$HOST" -p 5432 -U "$USER_" -d postgres -n public -Fc --no-owner --no-privileges \
  | gpg --batch --no-tty --quiet --trust-model always --compress-algo none --recipient "$RECIPIENT_FPR" --encrypt -o "$F.part"
[ -s "$F.part" ] || { rm -f "$F.part"; echo "empty dump" >&2; exit 4; }
mv "$F.part" "$F"; (cd "$OUT" && sha256sum "$(basename "$F")" > "$(basename "$F").sha256")
find "$OUT" -maxdepth 1 -name 'supabase-*.dump.gpg*' -mtime +"$KEEP_DAYS" -delete
echo "backup ok: $(basename "$F") $(stat -c %s "$F") bytes; kept $(ls "$OUT"/supabase-*.dump.gpg | wc -l)"
