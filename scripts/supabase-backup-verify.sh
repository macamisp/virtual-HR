#!/usr/bin/env bash
# Verify a Supabase backup made by scripts/supabase-backup.sh (ADR 052, NFR-REL-002). Prints no data or secrets.
#
#   bash scripts/supabase-backup-verify.sh <file>.dump.gpg             # checksum + encrypted to the pinned key
#   bash scripts/supabase-backup-verify.sh --restore <file>.dump.gpg   # + decrypt and restore into a throw-away
#                                                                       #   --network none PostgreSQL 17 (tmpfs)
# --restore needs the PRIVATE key: import it temporarily, run, then delete it from the keyring. Decrypted data
# only streams into the container's tmpfs and is gone when it exits.
set -euo pipefail
RESTORE=0; [ "${1:-}" = --restore ] && { RESTORE=1; shift; }
F=${1:?usage: supabase-backup-verify.sh [--restore] <file>.dump.gpg}
IMAGE=${PG_IMAGE:-docker.io/library/postgres:17-alpine}
EXPECT_TABLES=${EXPECT_TABLES:-84}

(cd "$(dirname "$F")" && sha256sum -c --quiet "$(basename "$F").sha256") && echo "PASS checksum"
[ "$(head -c 5 "$F")" != "PGDMP" ] && gpg --batch --list-only --list-packets "$F" 2>/dev/null | grep -q "^:pubkey enc packet:" \
  && echo "PASS encrypted (OpenPGP public-key), not plaintext"
[ $RESTORE = 1 ] || exit 0

NAME=hrvo-backup-verify-$$
podman run -d --rm --name "$NAME" --network none --tmpfs /var/lib/postgresql/data \
  -e POSTGRES_HOST_AUTH_METHOD=trust "$IMAGE" >/dev/null
trap 'podman stop -t 2 "$NAME" >/dev/null 2>&1 || true' EXIT
until podman exec "$NAME" pg_isready -q -U postgres 2>/dev/null; do sleep 0.5; done; sleep 1
podman exec "$NAME" psql -qU postgres -c "CREATE ROLE hrvo_app; CREATE ROLE hrvo_retention; CREATE ROLE hrvo_admin;" >/dev/null
gpg --batch --quiet -d "$F" | podman exec -i "$NAME" pg_restore -U postgres -d postgres --no-owner --no-privileges 2>&1 \
  | grep -vE 'schema "public" already exists|errors ignored on restore|^pg_restore: (error|detail|while)|Command was: CREATE SCHEMA public|^$' || true
q() { podman exec "$NAME" psql -U postgres -tAc "$1"; }
T=$(q "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE nspname='public' AND relkind='r'")
R=$(q "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE nspname='public' AND relkind='r' AND relforcerowsecurity")
M=$(q "SELECT count(*) FROM public._prisma_migrations WHERE finished_at IS NOT NULL")
O=$(q "SELECT count(*) FROM public.organizations"); U=$(q "SELECT count(*) FROM public.users")
echo "restored: tables=$T force_rls=$R migrations=$M organizations=$O users=$U"
[ "$T" -ge "$EXPECT_TABLES" ] && [ "$R" -ge $((EXPECT_TABLES - 1)) ] && [ "$M" -ge 36 ] && echo "PASS restore" || { echo "FAIL restore"; exit 1; }
