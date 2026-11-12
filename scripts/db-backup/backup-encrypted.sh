#!/usr/bin/env bash
# Consistent, client-side encrypted PostgreSQL backup (NFR-REL-002, NFR-SEC-001, ADR 051).
#
# Runs on the database host. Read-only towards PostgreSQL: one REPEATABLE READ READ ONLY
# transaction exports a snapshot; pg_dump and the row-count baseline both use that snapshot.
# Plaintext never touches disk: pg_dump streams straight into gpg (public key only on the host).
#
# Usage: RECIPIENT_FPR=<40-hex fingerprint> [PG_CONTAINER=..] [DOCKER="sudo -n docker"] \
#        [OUT_ROOT=$HOME/hrvo-backups] [KIND=daily|weekly|adhoc] backup-encrypted.sh
# Output: $OUT_ROOT/hrvo-<UTC>-<KIND>/ { db.dump.gpg, roles.sql.gpg, counts.tsv, migrations.tsv,
#         schema.tsv, manifest.txt, SHA256SUMS } — all mode 600 inside a mode-700 directory.
set -euo pipefail
umask 077

: "${RECIPIENT_FPR:?set RECIPIENT_FPR to the backup encryption key fingerprint}"
[[ $RECIPIENT_FPR =~ ^[0-9A-F]{40}$ ]] || { echo "RECIPIENT_FPR must be 40 upper-case hex" >&2; exit 2; }
read -r -a DOCKER <<<"${DOCKER:-sudo -n docker}"
PG=${PG_CONTAINER:-hrvo-staging-postgres-1}
KIND=${KIND:-adhoc}; [[ $KIND =~ ^(daily|weekly|adhoc)$ ]] || { echo "bad KIND" >&2; exit 2; }
OUT_ROOT=${OUT_ROOT:-$HOME/hrvo-backups}
TS=$(date -u +%Y%m%dT%H%M%SZ)
OUT="$OUT_ROOT/hrvo-$TS-$KIND"

waitfile() { for _ in $(seq 50); do [[ -s $1 ]] && return 0; sleep 0.2; done; echo "hash file $1 missing" >&2; return 1; }
log() { printf '%s %s\n' "$(date -u +%H:%M:%SZ)" "$*" >&2; }

# --- preflight -------------------------------------------------------------------------
gpg --batch --with-colons --fingerprint "$RECIPIENT_FPR" 2>/dev/null \
  | awk -F: -v f="$RECIPIENT_FPR" '$1=="fpr"&&$10==f{ok=1} END{exit !ok}' \
  || { echo "public key $RECIPIENT_FPR not in keyring" >&2; exit 3; }
gpg --batch --with-colons --list-keys "$RECIPIENT_FPR" \
  | awk -F: '($1=="pub"||$1=="sub") && $12 ~ /e/ && $2 !~ /[erd]/ {ok=1} END{exit !ok}' \
  || { echo "key $RECIPIENT_FPR has no valid encryption capability" >&2; exit 3; }
mkdir -p -m 700 "$OUT_ROOT"; mkdir -m 700 "$OUT"
avail_kb=$(df -Pk "$OUT_ROOT" | awk 'NR==2{print $4}')
(( avail_kb > 1048576 )) || { echo "less than 1 GiB free under $OUT_ROOT" >&2; exit 4; }
"${DOCKER[@]}" exec "$PG" pg_isready -q || { echo "postgres not ready" >&2; exit 5; }

GPG=(gpg --batch --no-tty --quiet --trust-model always --compress-algo none
     --recipient "$RECIPIENT_FPR" --encrypt)   # full fingerprint pins the key; gpg selects its encryption subkey
PSQL='exec psql -X -q -A -t -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'

# --- snapshot owner session ---------------------------------------------------------------
coproc SNAP { "${DOCKER[@]}" exec -i "$PG" sh -c "$PSQL" 2>&1; }
cleanup() { if [[ -n ${SNAP_PID:-} ]] && kill -0 "$SNAP_PID" 2>/dev/null; then
              printf 'ROLLBACK;\n\\q\n' >&"${SNAP[1]}" 2>/dev/null || true; wait "$SNAP_PID" 2>/dev/null || true; fi; }
trap cleanup EXIT
q() { printf '%s\n\\echo __END__\n' "$1" >&"${SNAP[1]}"; local l; while IFS= read -r -t 60 l <&"${SNAP[0]}"; do
        [[ $l == __END__ ]] && return 0; printf '%s\n' "$l"; done; echo "snapshot session timed out" >&2; return 1; }

q "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL lock_timeout = '10s'; SET LOCAL idle_in_transaction_session_timeout = '15min';" >/dev/null
SNAPID=$(q "SELECT pg_export_snapshot();")
[[ $SNAPID =~ ^[0-9A-F-]+$ ]] || { echo "unexpected snapshot id: $SNAPID" >&2; exit 6; }
SNAP_AT=$(q "SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"');")
log "snapshot exported at $SNAP_AT"

# --- dump (same snapshot), streamed into gpg ---------------------------------------------
log "pg_dump -> gpg"
"${DOCKER[@]}" exec "$PG" sh -c 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc -Z 6 --lock-wait-timeout=10s --snapshot="$1"' sh "$SNAPID" \
  | tee >(sha256sum | cut -d' ' -f1 >"$OUT/db.dump.plain.sha256") \
  | "${GPG[@]}" -o "$OUT/db.dump.gpg"
st=("${PIPESTATUS[@]}"); [[ ${st[*]} == "0 0 0" ]] || { echo "dump pipeline failed: ${st[*]}" >&2; exit 7; }

log "roles (no password hashes) -> gpg"
"${DOCKER[@]}" exec "$PG" sh -c 'exec pg_dumpall -U "$POSTGRES_USER" -l "$POSTGRES_DB" --roles-only --no-role-passwords' \
  | tee >(sha256sum | cut -d' ' -f1 >"$OUT/roles.sql.plain.sha256") \
  | "${GPG[@]}" -o "$OUT/roles.sql.gpg"
st=("${PIPESTATUS[@]}"); [[ ${st[*]} == "0 0 0" ]] || { echo "roles pipeline failed: ${st[*]}" >&2; exit 7; }

# --- baseline in the same snapshot (metadata only, never business rows) --------------------
log "baseline counts in snapshot"
q "SELECT format('SELECT %L || chr(9) || count(*) FROM %I.%I;', n.nspname||'.'||c.relname, n.nspname, c.relname)
   FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND c.relkind IN ('r','p')
   ORDER BY n.nspname, c.relname \\gexec" >"$OUT/counts.raw"   # no pipe: coproc fds are closed in pipeline subshells
sort "$OUT/counts.raw" >"$OUT/counts.tsv"; rm -f "$OUT/counts.raw"
q "SELECT migration_name || chr(9) || checksum FROM public._prisma_migrations
   WHERE rolled_back_at IS NULL AND finished_at IS NOT NULL ORDER BY 1;" >"$OUT/migrations.tsv"
q "SELECT 'tables_forced_rls' || chr(9) || count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='public' AND c.relkind IN ('r','p') AND c.relforcerowsecurity
   UNION ALL SELECT 'policies' || chr(9) || count(*) FROM pg_policies WHERE schemaname='public'
   UNION ALL SELECT 'security_definer_functions' || chr(9) || count(*) FROM pg_proc p
     JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prosecdef
   UNION ALL SELECT 'user_triggers' || chr(9) || count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
     JOIN pg_namespace n ON n.oid=c.relnamespace WHERE NOT t.tgisinternal AND n.nspname='public'
   UNION ALL SELECT 'indexes' || chr(9) || count(*) FROM pg_indexes WHERE schemaname='public'
   ORDER BY 1;" >"$OUT/schema.tsv"
SERVER_VERSION=$(q "SELECT current_setting('server_version');")
q "COMMIT;" >/dev/null; printf '\\q\n' >&"${SNAP[1]}"; wait "$SNAP_PID" || true; SNAP_PID=

waitfile "$OUT/db.dump.plain.sha256"; waitfile "$OUT/roles.sql.plain.sha256"
# --- manifest + checksums ------------------------------------------------------------------
{
  echo "created_utc=$TS"; echo "kind=$KIND"; echo "snapshot_utc=$SNAP_AT"
  echo "server_version=$SERVER_VERSION"; echo "container=$PG"
  echo "recipient_fpr=$RECIPIENT_FPR"
  echo "db_dump_plain_sha256=$(cat "$OUT/db.dump.plain.sha256")"
  echo "roles_sql_plain_sha256=$(cat "$OUT/roles.sql.plain.sha256")"
  echo "tables=$(wc -l <"$OUT/counts.tsv") total_rows=$(awk -F'\t' '{s+=$2} END{print s+0}' "$OUT/counts.tsv")"
  echo "migrations=$(wc -l <"$OUT/migrations.tsv")"
  echo "db_dump_gpg_bytes=$(stat -c %s "$OUT/db.dump.gpg") roles_sql_gpg_bytes=$(stat -c %s "$OUT/roles.sql.gpg")"
} >"$OUT/manifest.txt"
rm -f "$OUT/db.dump.plain.sha256" "$OUT/roles.sql.plain.sha256"
( cd "$OUT" && sha256sum db.dump.gpg roles.sql.gpg counts.tsv migrations.tsv schema.tsv manifest.txt >SHA256SUMS )
chmod 600 "$OUT"/*
log "done: $OUT"
echo "$OUT"
