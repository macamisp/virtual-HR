# Fresh Supabase database for new data (ADR 052)

No historical records are copied. The EC2 PostgreSQL container, its volume and `.env.staging.db` stay untouched.
Never paste passwords, connection strings or keys into chat, git or command arguments.

## 1. Create the project (user, Supabase dashboard)

1. **New project** in an organisation on the **Free** plan: name e.g. `virtual-hr`, region as chosen: the existing project
   *HR Virtual Office* is in **Singapore (ap-southeast-1)**; EC2 is in Sydney, so expect roughly 90 ms extra per round trip. Generate a strong database password and store it in your password manager.
   If the form offers *Enable Data API*, **untick it**. Add no add-ons, compute upgrades, PITR or IPv4.
2. **Data API off:** Project Settings → Data API (or Integrations → Data API): disable it, or at minimum remove
   `public` from the exposed schemas.
3. **SSL:** Database → Settings → SSL configuration: turn on *Enforce SSL*, then **Download certificate** to
   `/run/media/macami/DataDrive/hrvo-secrets/supabase/prod-ca-2021.crt` (outside the repo; `chmod 600`).
4. **Connect → Session pooler** (not Direct, not Transaction): note the host (e.g.
   `aws-0-ap-southeast-1.pooler.supabase.com`) and the user (`postgres.<project-ref>`).
5. Database → Settings → **Connection pooling**: note the *pool size*.

## 2. Private env file (user, workstation)

```bash
D=/run/media/macami/DataDrive/hrvo-secrets/supabase; mkdir -p -m 700 "$D"
cp .env.staging.supabase.example "$D/supabase.env"; chmod 600 "$D/supabase.env"
# random runtime-role passwords, written without printing them:
sed -i "s|^SUPABASE_APP_PASSWORD=.*|SUPABASE_APP_PASSWORD=$(openssl rand -hex 32)|;
        s|^SUPABASE_RETENTION_PASSWORD=.*|SUPABASE_RETENTION_PASSWORD=$(openssl rand -hex 32)|" "$D/supabase.env"
${EDITOR:-nano} "$D/supabase.env"   # host, postgres.<ref>, DB password, hrvo_app.<ref>, hrvo_retention.<ref>, CA path
```

## 3. Gate: target preflight (read-only)

```bash
node --experimental-strip-types apps/api/prisma/scripts/supabase-preflight.ts target "$D/supabase.env"
```

All checks must pass: project ref and pooler region (ap-southeast-1), non-TLS refused, hostname verified,
IPv4 reachability, verified TLS via the pooler, PostgreSQL 17, `postgres` has BYPASSRLS + CREATEROLE, API roles
present, `public` empty, LISTEN/NOTIFY delivered. **Any FAIL = stop.**

## 4. Initialise the schema (same code path as the EC2 migrate job)

```bash
node scripts/supabase-init.mjs "$D/supabase.env"
```

This runs lockdown `pre` → `prisma migrate deploy` (36 migrations) → role passwords → lockdown `post` + verify.
It is idempotent, and re-running it applies only new migrations.

## 5. Gate: application preflight + functional tests

```bash
node --experimental-strip-types apps/api/prisma/scripts/supabase-preflight.ts app "$D/supabase.env"
```

Then run the API end-to-end suites against the project with synthetic accounts (`*@example.test`),
concurrency 1 (session pool). They create and delete synthetic organisations; run them **only before cutover**.

## 6. Cutover (approval required)

**Effect:** the API stops reading the EC2 database. Existing accounts, workspaces and history are **not**
in Supabase, so nobody can sign in with an old account. People sign up again and start fresh. The EC2
`postgres` container, its volume `hrvo-staging_postgres_data` and `.env.staging.db` stay as they are.

Host facts (2026-11-12): checkout `a9b6714`; live API image `hrvo-api:staging` = V3 `44ea7f3`; web unchanged.
Runtime API diff to the release: only opt-in pool caps (`db-config.ts`, attendance pools). The migrate image gains the lockdown.

### 6.1 Server env file (operator, no admin password on the server)

Copy the workstation file **without** the admin password, and point the CA path at the server copy:

```bash
W=/run/media/macami/DataDrive/hrvo-secrets/supabase
grep -vE '^SUPABASE_ADMIN_PASSWORD=' "$W/supabase.env" \
  | sed 's|^SUPABASE_CA_FILE=.*|SUPABASE_CA_FILE=/opt/virtual-hr/secrets/supabase/prod-ca-2021.crt|' \
  | ssh ubuntu@HOST 'umask 077; cat > /opt/virtual-hr/app/.env.staging.supabase'
ssh ubuntu@HOST 'sudo install -d -m 700 /opt/virtual-hr/secrets/supabase'
scp "$W/prod-ca-2021.crt" ubuntu@HOST:/tmp/sb-ca.crt && ssh ubuntu@HOST \
  'sudo install -m 644 /tmp/sb-ca.crt /opt/virtual-hr/secrets/supabase/prod-ca-2021.crt && rm /tmp/sb-ca.crt'
```

(The CA is public; 644 lets the non-root container read it. The env file stays 600.)

### 6.2 Switch (API only)

```bash
cd /opt/virtual-hr/app
OLD="sudo -n docker compose -f docker-compose.staging.yml -f docker-compose.staging.ssh.yml -f docker-compose.staging.https.yml --env-file .env.staging --env-file .env.staging.db"
NEW="$OLD -f docker-compose.staging.supabase.yml --env-file .env.staging.supabase"
git fetch origin && git checkout --detach <release-sha>          # contains ADR 052
git diff --stat 44ea7f3..HEAD -- apps/api packages docker           # expect only the ADR 052 files
sudo docker tag hrvo-api:staging hrvo-api:v3-44ea7f3-pre-supabase   # rollback image
$NEW config -q                                                      # renders; postgres service unchanged
$NEW --profile tools config --format json | sudo -n docker run --rm -i --network none -v "$PWD/scripts:/s:ro" \
  --entrypoint node hrvo-api:staging --experimental-strip-types --no-warnings=ExperimentalWarning \
  /s/staging-compose-check.ts --api-subnet 172.30.1.0/29                 # policy (ADR 046/047), no host Node.js
$NEW build api
$NEW up -d --no-deps api                                            # recreates ONLY the API
```

Migrations are already applied (36). Future ones run from the workstation with `node scripts/supabase-init.mjs`.

### 6.3 Verify

1. `curl -fsS https://api.virtual-hr.site/health` returns 200; the API logs show no DB/TLS errors.
2. Sign up a new workspace, verify the email, sign in, create a task, start and stop attendance.
3. Supabase: rows appear (as postgres, read-only: `SELECT count(*) FROM organizations`). EC2: `organizations`
   count unchanged.
4. A second browser: an old account cannot sign in (expected).

### 6.4 Rollback (any time)

```bash
sudo docker tag hrvo-api:v3-44ea7f3-pre-supabase hrvo-api:staging
git checkout --detach a9b6714
$OLD up -d --no-deps api      # without the Supabase override: back on the EC2 database
```

The API immediately serves the old accounts again. Anything created in Supabase after cutover is not visible
there (it stays in Supabase).
