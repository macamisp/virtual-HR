#!/usr/bin/env bash
# Daily encrypted logical backup of the Sydney Supabase database (ADR 052, NFR-REL-002). Runs on the OPERATOR
# WORKSTATION, never on EC2: the Supabase admin login stays in the private env file here. pg_dump 17
# (podman) streams straight into gpg (public key only), so plaintext never touches disk. Prints no secrets.
#
#   RECIPIENT_FPR=<40-hex> bash scripts/supabase-backup.sh [env-file] [out-dir]
#   verify:  bash scripts/supabase-backup-verify.sh <file>.dump.gpg   (private key needed only with --restore)
#
# Exit codes: 2 config, 3 key, 4 dump/encrypt failed. Every run writes $OUT/last-status (ok|FAILED + UTC time),
# and a failing run exits non-zero so the systemd OnFailure= unit raises a desktop notification.
set -euo pipefail
ENV_FILE=${1:-/run/media/macami/DataDrive/hrvo-secrets/supabase-sydney/supabase.env}
OUT=${2:-/run/media/macami/DataDrive/hrvo-backups/supabase}
KEEP_DAYS=${KEEP_DAYS:-14}
IMAGE=${PG_IMAGE:-docker.io/library/postgres:17-alpine}
EXPECT_HOST=${EXPECT_HOST:-aws-0-ap-southeast-2.pooler.supabase.com}   # Sydney session pooler only
EXPECT_REF=${EXPECT_REF:-czagpdusgatugojguwgf}                        # Virtual-HR Sydney

umask 077; mkdir -p "$OUT"
STATUS="$OUT/last-status"
fail() { echo "FAILED $(date -u +%FT%TZ) $2" > "$STATUS"; echo "$2" >&2; exit "$1"; }

: "${RECIPIENT_FPR:?set RECIPIENT_FPR to the backup encryption key fingerprint}"
[[ $RECIPIENT_FPR =~ ^[0-9A-F]{40}$ ]] || fail 2 "RECIPIENT_FPR must be 40 upper-case hex"
[ -f "$ENV_FILE" ] && [ "$(stat -c %a "$ENV_FILE")" = 600 ] || fail 2 "$ENV_FILE missing or not mode 600"
gpg --batch --with-colons --list-keys "$RECIPIENT_FPR" 2>/dev/null \
  | awk -F: '($1=="pub"||$1=="sub") && $2!~/[ider]/ && $12~/e/ {ok=1} END{exit !ok}' \
  || fail 3 "no valid (not expired/revoked) encryption key for $RECIPIENT_FPR"

val() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -1 | sed -E "s/^(['\"])(.*)\1$/\2/"; }
HOST=$(val SUPABASE_PGHOST); USER_=$(val SUPABASE_ADMIN_USER); CA=$(val SUPABASE_CA_FILE)
[ "$HOST" = "$EXPECT_HOST" ] || fail 2 "SUPABASE_PGHOST is not the Sydney pooler"
[[ $USER_ == *".$EXPECT_REF" ]] || fail 2 "SUPABASE_ADMIN_USER is not for project $EXPECT_REF"
[ -f "$CA" ] || fail 2 "SUPABASE_CA_FILE missing"

STAMP=$(date -u +%Y%m%dT%H%M%SZ); F="$OUT/supabase-$STAMP.dump.gpg"
trap 'rm -f "$F.part"' EXIT   # a failed run leaves no partial file (it is ciphertext anyway)
PGPASSWORD=$(val SUPABASE_ADMIN_PASSWORD) podman run --rm -i -e PGPASSWORD \
    -e PGSSLMODE=verify-full -e PGSSLROOTCERT=/ca.crt -v "$CA:/ca.crt:ro,Z" "$IMAGE" \
    pg_dump -h "$HOST" -p 5432 -U "$USER_" -d postgres -n public -Fc --no-owner --no-privileges \
  | gpg --batch --no-tty --quiet --trust-model always --compress-algo none --recipient "$RECIPIENT_FPR" --encrypt -o "$F.part" \
  || fail 4 "pg_dump or gpg failed"
[ -s "$F.part" ] || fail 4 "empty output"
# Ciphertext check: an OpenPGP message encrypted to the pinned key, never a plaintext custom-format dump.
[ "$(head -c 5 "$F.part")" != "PGDMP" ] || fail 4 "output is plaintext"
gpg --batch --list-packets "$F.part" 2>/dev/null | grep -q "^:pubkey enc packet:" || fail 4 "output is not public-key encrypted"
mv "$F.part" "$F"; (cd "$OUT" && sha256sum "$(basename "$F")" > "$(basename "$F").sha256")
find "$OUT" -maxdepth 1 -name 'supabase-*.dump.gpg*' -mtime +"$KEEP_DAYS" -delete
echo "ok $(date -u +%FT%TZ) $(basename "$F") $(stat -c %s "$F")" > "$STATUS"
echo "backup ok: $(basename "$F") $(stat -c %s "$F") bytes; kept $(find "$OUT" -maxdepth 1 -name 'supabase-*.dump.gpg' | wc -l)"
