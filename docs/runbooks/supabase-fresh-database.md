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

Existing accounts and history will **not** exist in the new database; everyone signs up again.

```bash
# on EC2, in /opt/virtual-hr/app (checkout containing ADR 052), with the env file and CA under /opt/virtual-hr/secrets/supabase/
OLD="docker compose -f docker-compose.staging.yml -f docker-compose.staging.ssh.yml -f docker-compose.staging.https.yml --env-file .env.staging --env-file .env.staging.db"
NEW="$OLD -f docker-compose.staging.supabase.yml --env-file .env.staging.supabase"
git -C /opt/virtual-hr/app diff --stat <deployed>..<release> -- apps/api packages docker   # review API changes
sudo docker tag hrvo-api:staging hrvo-api:pre-supabase-<deployed>   # keep the running image for rollback
sudo docker tag hrvo-api-migrate:staging hrvo-api-migrate:pre-supabase-<deployed>
$NEW config -q && $NEW build api migrate        # new images (lockdown + pool caps)
$NEW run --rm --no-deps migrate                 # idempotent against Supabase
$NEW up -d --no-deps api                        # only the API is recreated
```

Verify: `/health` 200, then a new signup → workspace → task → attendance, and confirm the rows exist in Supabase
(Table editor, as the dashboard user) while the EC2 database's row counts are unchanged.

**Rollback (before or after new sign-ups):** `sudo docker tag hrvo-api:pre-supabase-<deployed> hrvo-api:staging`
then `$OLD up -d --no-deps api`. The API is back on EC2 PostgreSQL (configuration and image) immediately.
Data created in Supabase after cutover is not visible there.
