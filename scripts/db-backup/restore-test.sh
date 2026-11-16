#!/usr/bin/env bash
# Isolated restore test for a backup made by backup-encrypted.sh (NFR-REL-002, ADR 051).
#
# Runs on the workstation that holds the decryption key. The restore target is a throwaway
# postgres:16.10-alpine container with no network and its data directory on tmpfs, so
# decrypted data never reaches disk and is gone when the container is removed.
#
# Usage: restore-test.sh <backup-dir> [source-manifest.json]
#   GNUPGHOME may point at a dedicated keyring; gpg asks for the key passphrase via pinentry.
set -euo pipefail
umask 077
DIR=${1:?backup directory}; MANIFEST=${2:-docs/migrations/source-manifest.json}
HERE=$(cd "$(dirname "$0")" && pwd)
IMAGE=${RESTORE_IMAGE:-docker.io/library/postgres:16.10-alpine}
NAME="hrvo-restore-test-$(date -u +%Y%m%dT%H%M%SZ)"
SU=hrvo_restore_su            # unique bootstrap superuser: never collides with restored roles
RESULT=FAIL
waitfile() { for _ in $(seq 50); do [[ -s $1 ]] && return 0; sleep 0.2; done; echo "hash file $1 missing" >&2; return 1; }
log() { printf '%s %s\n' "$(date -u +%H:%M:%SZ)" "$*" >&2; }
cleanup() { podman rm -f "$NAME" >/dev/null 2>&1 || true; log "restore test $RESULT; container removed"; }
trap cleanup EXIT

log "1/6 ciphertext checksums"
( cd "$DIR" && sha256sum --quiet -c SHA256SUMS )
get() { awk -F= -v k="$1" '$1==k{print $2}' "$DIR/manifest.txt"; }

log "2/6 start isolated container (network none, tmpfs data)"
podman run -d --rm --name "$NAME" --network none \
  --tmpfs /var/lib/postgresql/data:rw,size=2g,mode=0700 \
  -e POSTGRES_USER=$SU -e POSTGRES_DB=$SU -e POSTGRES_PASSWORD="$(openssl rand -hex 24)" \
  "$IMAGE" >/dev/null
for _ in $(seq 60); do podman exec "$NAME" pg_isready -q -U $SU 2>/dev/null && break; sleep 1; done
sleep 2; podman exec "$NAME" pg_isready -q -U $SU
PSQL=(podman exec -i "$NAME" psql -X -q -v ON_ERROR_STOP=1 -U $SU -d)

T0=$(date +%s)
log "3/6 roles, then database (fail on first error)"
gpg --batch --quiet --decrypt "$DIR/roles.sql.gpg" \
  | tee >(sha256sum | cut -d' ' -f1 >"$DIR/.roles.check") | "${PSQL[@]}" $SU >/dev/null
gpg --batch --quiet --decrypt "$DIR/db.dump.gpg" \
  | tee >(sha256sum | cut -d' ' -f1 >"$DIR/.dump.check") \
  | podman exec -i "$NAME" pg_restore -U $SU -d $SU --create --exit-on-error
waitfile "$DIR/.dump.check"; waitfile "$DIR/.roles.check"
[[ $(cat "$DIR/.dump.check") == "$(get db_dump_plain_sha256)" ]] || { echo "dump plaintext hash mismatch" >&2; exit 10; }
[[ $(cat "$DIR/.roles.check") == "$(get roles_sql_plain_sha256)" ]] || { echo "roles plaintext hash mismatch" >&2; exit 10; }
rm -f "$DIR/.dump.check" "$DIR/.roles.check"
RESTORE_S=$(( $(date +%s) - T0 ))
DB=$(podman exec "$NAME" psql -X -At -U $SU -d $SU -c "SELECT datname FROM pg_database WHERE datname NOT IN ('postgres','template0','template1','$SU')")
log "restored database: $DB in ${RESTORE_S}s"

log "4/6 row counts vs snapshot baseline"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"; cleanup' EXIT
"${PSQL[@]}" "$DB" -A -t <<'SQL' | sort >"$TMP/counts.tsv"
SELECT format('SELECT %L || chr(9) || count(*) FROM %I.%I;', n.nspname||'.'||c.relname, n.nspname, c.relname)
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND c.relkind IN ('r','p') ORDER BY 1 \gexec
SQL
diff -u "$DIR/counts.tsv" "$TMP/counts.tsv" >&2 || { echo "row counts differ" >&2; exit 11; }

log "5/6 migrations vs baseline and repository manifest; schema/RLS fingerprints"
"${PSQL[@]}" "$DB" -A -t -c "SELECT migration_name || chr(9) || checksum FROM public._prisma_migrations
  WHERE rolled_back_at IS NULL AND finished_at IS NOT NULL ORDER BY 1" >"$TMP/migrations.tsv"
diff -u "$DIR/migrations.tsv" "$TMP/migrations.tsv" >&2 || { echo "migration records differ" >&2; exit 12; }
node -e 'const m=require(require("path").resolve(process.argv[1]));for(const x of m.migrations)console.log(x.migration_name+"\t"+x.sha256)' "$MANIFEST" | sort >"$TMP/repo.tsv"
if ! diff -q "$TMP/repo.tsv" "$TMP/migrations.tsv" >/dev/null; then
  log "note: DB migrations differ from repository manifest (expected if the manifest is older/newer):"
  diff "$TMP/repo.tsv" "$TMP/migrations.tsv" | grep '^[<>]' | cut -f1 >&2 || true
fi
"${PSQL[@]}" "$DB" -A -t -f - <"$HERE/fingerprint.sql" >"$TMP/schema.tsv"
[[ $(sha256sum "$HERE/fingerprint.sql" | cut -d' ' -f1) == "$(get fingerprint_sql_sha256)" ]] \
  || log "warning: fingerprint.sql differs from the version used at backup time"
diff -u "$DIR/schema.tsv" "$TMP/schema.tsv" >&2 || { echo "schema/role/RLS fingerprints differ" >&2; exit 13; }
sed 's/^/  /' "$TMP/schema.tsv" | cut -c1-110 >&2

log "6/6 tenant isolation as hrvo_app (FORCE RLS): no context, two tenants, cross-tenant write"
"${PSQL[@]}" "$DB" -A -t -c "SELECT rolname||' super='||rolsuper||' bypassrls='||rolbypassrls FROM pg_roles WHERE rolname IN ('hrvo_app','hrvo_retention') ORDER BY 1" >&2
"${PSQL[@]}" "$DB" -f - <"$HERE/tenant-isolation.sql" >"$TMP/iso.txt"
ISO=$(sed -n 's/^isolation\t//p' "$TMP/iso.txt"); log "  $ISO"
grep '^isolation_detail' "$TMP/iso.txt" | cut -f2 | sed 's/^/  FAIL /' >&2 || true
[[ $ISO == *" failures=0" ]] || { echo "tenant isolation failed" >&2; exit 14; }
A=$(podman exec "$NAME" psql -X -At -U $SU -d "$DB" -c "SELECT id FROM public.users ORDER BY id LIMIT 1")
if [[ -n $A ]]; then
  WRITE=$(podman exec -i "$NAME" psql -X -q -At -v ON_ERROR_STOP=1 -U $SU -d "$DB" 2>&1 <<SQL || true
BEGIN;
SELECT set_config('app.org_id', (SELECT org_id::text FROM public.users WHERE id = '$A'), true) \\g /dev/null
SET LOCAL ROLE hrvo_app;
UPDATE public.users SET org_id = gen_random_uuid() WHERE id = '$A';
ROLLBACK;
SQL
)
  [[ $WRITE == *"row-level security"* ]] || { echo "cross-tenant UPDATE was not refused by RLS: ${WRITE:0:200}" >&2; exit 15; }
  log "  cross-tenant UPDATE refused by RLS (rolled back)"
fi

RESULT=PASS
echo "PASS dir=$(basename "$DIR") db=$DB tables=$(wc -l <"$TMP/counts.tsv") restore_seconds=$RESTORE_S snapshot=$(get snapshot_utc)"
