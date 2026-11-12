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
"${PSQL[@]}" "$DB" -A -t <<'SQL' >"$TMP/schema.tsv"
SELECT 'tables_forced_rls' || chr(9) || count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relkind IN ('r','p') AND c.relforcerowsecurity
UNION ALL SELECT 'policies' || chr(9) || count(*) FROM pg_policies WHERE schemaname='public'
UNION ALL SELECT 'security_definer_functions' || chr(9) || count(*) FROM pg_proc p
  JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prosecdef
UNION ALL SELECT 'user_triggers' || chr(9) || count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
  JOIN pg_namespace n ON n.oid=c.relnamespace WHERE NOT t.tgisinternal AND n.nspname='public'
UNION ALL SELECT 'indexes' || chr(9) || count(*) FROM pg_indexes WHERE schemaname='public'
ORDER BY 1;
SQL
diff -u "$DIR/schema.tsv" "$TMP/schema.tsv" >&2 || { echo "schema fingerprints differ" >&2; exit 13; }

log "6/6 runtime role still fail-closed under FORCE RLS"
"${PSQL[@]}" "$DB" -A -t -c "SELECT rolname||' super='||rolsuper||' bypassrls='||rolbypassrls FROM pg_roles WHERE rolname IN ('hrvo_app','hrvo_retention') ORDER BY 1" >&2
LEAK=$("${PSQL[@]}" "$DB" -A -t -c "SET ROLE hrvo_app; SELECT count(*) FROM public.users;" 2>&1 || true)
[[ $LEAK == 0 ]] || { echo "hrvo_app without app.org_id saw users: $LEAK" >&2; exit 14; }

RESULT=PASS
echo "PASS dir=$(basename "$DIR") db=$DB tables=$(wc -l <"$TMP/counts.tsv") restore_seconds=$RESTORE_S snapshot=$(get snapshot_utc)"
