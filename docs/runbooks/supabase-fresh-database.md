# Fresh Supabase database for new data (ADR 052)

No historical records are copied. The EC2 PostgreSQL container, its volume and `.env.staging.db` stay untouched.
Never paste passwords, connection strings or keys into chat, git or command arguments.

## 1. Create the project (user, Supabase dashboard)

1. **New project** in an organisation on the **Free** plan, in **Sydney (ap-southeast-2)**, the same region as EC2.
   Done 2026-11-12: *Virtual-HR Sydney*, ref `czagpdusgatugojguwgf`, PG 17.11, session pool 15. (The Singapore project
   was NO-GO: about 44 sequential round trips on the FR-ATT-002 logout path break the 1 s requirement at about 90 ms
   RTT.) Generate a strong database password and store it in your password manager.
   If the form offers *Enable Data API*, **untick it**. Add no add-ons, compute upgrades, PITR or IPv4.
2. **Data API off:** Project Settings → Data API (or Integrations → Data API): disable it, or at minimum remove
   `public` from the exposed schemas.
3. **SSL:** Database → Settings → SSL configuration: turn on *Enforce SSL*, then **Download certificate** to
   `/run/media/macami/DataDrive/hrvo-secrets/supabase-sydney/prod-ca-2021.crt` (outside the repo; `chmod 600`).
4. **Connect → Session pooler** (not Direct, not Transaction): note the host (e.g.
   `aws-0-ap-southeast-2.pooler.supabase.com`) and the user (`postgres.<project-ref>`).
5. Database → Settings → **Connection pooling**: note the *pool size*.

## 2. Private env file (user, workstation)

```bash
D=/run/media/macami/DataDrive/hrvo-secrets/supabase-sydney; mkdir -p -m 700 "$D"
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

All checks must pass: project ref and pooler region (ap-southeast-2), non-TLS refused, hostname verified,
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

Functional correctness was already proven on the identical schema (workstation suites). **Do not re-run the full
suites**: from the workstation they fail only the 1 s logout tests, because of the workstation's RTT to Sydney
(about 200 ms). If a suite is interrupted, its synthetic orgs (`*-e2e`, `*.test` users) stay behind: delete them
as `postgres` with `DELETE FROM organizations WHERE slug = '<slug>'` (cascades), then confirm every table is empty.

### 5.1 Gate: minimal EC2 probe (approval required; no live changes)

After §6.1 (the env file and CA are on the server), on the host, from `/opt/virtual-hr/app` with the ADR 052 checkout:

```bash
bash scripts/supabase-ec2-probe.sh
```

It uses a throw-away container from the existing `hrvo-api:staging` image on its own bridge network, read-only,
256 MB / 0.5 CPU / 64 PIDs, no capabilities, and the restricted roles only (it refuses to run if the admin password
is present). It checks the Sydney identity, verified TLS for both roles, fail-closed FORCE RLS, foreign-tenant
invisibility, no bypass (`SET ROLE`, `row_security=off`), the logout path's 44 sequential round trips under 500 ms,
10 concurrent sessions (the API's worst case) and LISTEN/NOTIFY. It prints the live containers before and after.
A second step (`supabase-ec2-logout.mjs`, in the same container) seeds two synthetic tenants as `hrvo_app`
(`*.sbprobe.test`), checks cross-tenant reads and writes, opens an attendance session with a signed heartbeat
and times the logout with the image's own code: the `AuthService.logout` transaction, then `hasOtherLiveLogin`
and `onExplicitLogout`. It deletes its tenants at the end. **Any FAIL = stop.** Stage the files in a temporary
directory, not in `/opt/virtual-hr/app`: `ENV_FILE=<dir>/sb.env CA=<dir>/ca.crt bash <dir>/scripts/supabase-ec2-probe.sh`.

**Result 2026-11-12 09:5x UTC (EC2, image `hrvo-api:staging` = V3 44ea7f3): 24/24 PASS.** Connect 34–50 ms;
RTT p50 2.3 ms, p95 2.6 ms; 44 round trips 103 ms; 10 sessions in 105 ms; NOTIFY 3 ms; **logout 93 / 89 / 85 ms**
(limit 1 s). Live containers were unchanged before and after, and every temporary resource was removed.
Sign-up through the real API is §6.3.

### 5.2 Backups (Free plan)

The Free plan has no downloadable backups and no PITR. `scripts/supabase-backup.sh` runs on the **workstation**
(the admin login never goes to EC2). `pg_dump` 17 (podman) streams into `gpg --encrypt` to a public key, so
plaintext never touches the unencrypted disk. It writes `supabase-<UTC>.dump.gpg` plus a `.sha256` and keeps
14 days. Verified 2026-11-12 with a throw-away key: encrypted, the checksum is OK, and after decryption
`pg_restore --list` shows 84 tables, 29 functions and 83 policies.

One-time setup (user): create a backup key and keep the private key **offline** (password manager or USB),
leaving only the public key in the workstation keyring:

```bash
gpg --quick-gen-key 'Virtual-HR backup' ed25519 sign 2y && FPR=<40-hex fingerprint>
gpg --quick-add-key "$FPR" cv25519 encr 2y
gpg --export-secret-keys --armor "$FPR" > /path/offline/hrvo-backup-secret.asc  # then move it offline
mkdir -p ~/.config/systemd/user && cat > ~/.config/systemd/user/hrvo-supabase-backup.service <<EOF
[Service]
Type=oneshot
Environment=RECIPIENT_FPR=$FPR
ExecStart=/usr/bin/bash "/run/media/macami/DataDrive/Hr virtual office/scripts/supabase-backup.sh"
EOF
printf '[Timer]\nOnCalendar=*-*-* 02:30:00\nPersistent=true\n[Install]\nWantedBy=timers.target\n' \
  > ~/.config/systemd/user/hrvo-supabase-backup.timer
systemctl --user daemon-reload && systemctl --user enable --now hrvo-supabase-backup.timer
systemctl --user start hrvo-supabase-backup.service && journalctl --user -u hrvo-supabase-backup -n 3
```

`Persistent=true` catches up on missed runs after the workstation was off. The data drive must be mounted.
Restore test: `gpg -d <file> | podman run --rm -i --network none postgres:17-alpine pg_restore --list`.
Upgrade to Pro (daily backups, optional PITR) when the data matters.

### 5.3 Connection budget (session pool 15 per user)

`hrvo_app` worst case = Prisma engine `L` + 3 pg pools of `P` (Prisma pg pool, attendance app, attendance admin,
which falls back to `hrvo_app` because the API gets no `PGADMIN_*`) + 1 listener = `L + 3P + 1`. At
`SUPABASE_PRISMA_CONNECTION_LIMIT=3` and `SUPABASE_PG_POOL_MAX=2` that is **10**, leaving room for the probe,
migrations and the overlap while the API restarts. Run **exactly one** API container against the project: no
second host, no `--scale`, and keep the EC2 dev or demo stacks off it.

## 6. Cutover (approval required)

**Effect:** the API stops reading the EC2 database. Existing accounts, workspaces and history are **not**
in Supabase, so nobody can sign in with an old account. People sign up again and start fresh. The EC2
`postgres` container, its volume `hrvo-staging_postgres_data` and `.env.staging.db` stay as they are.

Host facts (2026-11-12): checkout `a9b6714`; live API image `hrvo-api:staging` = V3 `44ea7f3`; web unchanged.
Runtime API diff to the release: only opt-in pool caps (`db-config.ts`, attendance pools, the `PrismaService` pg pool). The migrate image gains the lockdown. The live image ignores the caps, so the switch **must** build the API.

### 6.1 Server env file (operator, no admin password on the server)

Copy the workstation file **without** the admin password, and point the CA path at the server copy:

```bash
W=/run/media/macami/DataDrive/hrvo-secrets/supabase-sydney
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
sudo cp -a .env.staging .env.staging.pre-supabase                    # rollback env (unchanged by the switch)
grep -cE '^PGADMIN_(USER|PASSWORD)=' .env.staging                    # expect 0: the API gets no admin login
sudo -n docker volume inspect hrvo-staging_postgres_data -f '{{.Name}} {{.CreatedAt}}'   # old DB volume kept
sudo -n docker ps --filter name=postgres --format '{{.Names}} {{.Status}}'             # old DB keeps running
sudo -n docker ps --filter name=api --format '{{.Names}}' | wc -l                       # expect 1 API container
$NEW config -q                                                      # renders; postgres service unchanged
$NEW --profile tools config --format json | sudo -n docker run --rm -i --network none -v "$PWD/scripts:/s:ro" \
  --entrypoint node hrvo-api:staging --experimental-strip-types --no-warnings=ExperimentalWarning \
  /s/staging-compose-check.ts --api-subnet 172.30.1.0/29                 # policy (ADR 046/047), no host Node.js
$NEW build api
$NEW up -d --no-deps api                                            # recreates ONLY the API
```

Migrations are already applied (36). Future ones run from the workstation with `node scripts/supabase-init.mjs`.

`$NEW build api` does not restart anything. It can run before the switch window (about 5–10 min on 2 vCPU).
Only `up -d --no-deps api` recreates a container: the overlay defines only `api` and `migrate` (the
`tools` profile, never started by `up`), and `--no-deps` keeps web, postgres, redis, storage, clamav and the
proxy as they are. Before and after, `sudo -n docker ps --format '{{.Names}} {{.Status}}'` must show the same
uptime for everything except the API.

### 6.3 Verify (smoke tests, within 15 minutes)

1. `curl -fsS https://api.virtual-hr.site/health` returns 200, and `docker logs --since 5m` for the API shows no
   `ECONNREFUSED`, `EMAXCONNSESSION`, `self-signed`, `password authentication failed` or Prisma `P1001`/`P1017`.
2. Sign up a new workspace (real mailbox), verify the email, and sign in.
3. Create a task, start attendance (the heartbeat is accepted), log out, and sign in again: the session closed
   at logout (FR-ATT-002).
4. Sign up a second workspace in another browser: it does not see the first workspace's people, tasks or
   attendance.
5. Old account: the sign-in is refused, and an old browser tab is sent to sign-in. It must not get a 500.
6. Supabase (workstation, read-only as postgres): `organizations` = 2, and `pg_stat_activity` for `hrvo_app`
   shows 10 or fewer sessions. EC2 postgres: still running, uptime unchanged.
7. The next morning: the backup timer wrote one `.dump.gpg`.

**Rollback triggers (any one = §6.4 immediately, no debugging on production):** health is not 200 for over
2 min · repeated DB/TLS/pool errors in the API log · sign-up or sign-in fails · logout does not close the
session · any cross-tenant data visible · any 5xx on the main pages · any container other than the API was
recreated.

### 6.4 Rollback (any time)

```bash
sudo docker tag hrvo-api:v3-44ea7f3-pre-supabase hrvo-api:staging
git checkout --detach a9b6714
$OLD up -d --no-deps api      # without the Supabase override: back on the EC2 database
```

The API immediately serves the old accounts again. Anything created in Supabase after cutover is not visible
there (it stays in Supabase).
