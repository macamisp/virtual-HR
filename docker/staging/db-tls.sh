#!/usr/bin/env bash
# Creates the staging database CA and the PostgreSQL server certificate (ADR 046). Run once on the
# server; the API and the migration job verify the database against ca.crt (PGSSLMODE=verify-full,
# host name "postgres"). The CA key is not needed afterwards: keep it offline or delete it.
#
#   bash docker/staging/db-tls.sh [/opt/virtual-hr/secrets/db-tls]
set -euo pipefail
dir="${1:-./.staging/db-tls}"
if [ -e "$dir/server.key" ]; then echo "$dir/server.key exists; not overwriting" >&2; exit 1; fi
umask 077
mkdir -p "$dir"
cd "$dir"
openssl req -x509 -newkey rsa:4096 -sha256 -days 1825 -nodes -keyout ca.key -out ca.crt -subj "/CN=HRVO staging database CA" \
  -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
openssl req -newkey rsa:2048 -sha256 -nodes -keyout server.key -out server.csr -subj "/CN=postgres" 2>/dev/null
printf 'basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:postgres\n' > server.ext
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 825 -sha256 -extfile server.ext -out server.crt 2>/dev/null
rm -f server.csr server.ext ca.srl
# The certificates are public; the key stays 600 (postgres starts as root, copies it into place
# with the ownership PostgreSQL requires, then drops privileges).
chmod 644 ca.crt server.crt
chmod 600 server.key ca.key
openssl verify -CAfile ca.crt server.crt
echo "Created $dir/{ca.crt,server.crt,server.key} (and ca.key: move it off the server)."
