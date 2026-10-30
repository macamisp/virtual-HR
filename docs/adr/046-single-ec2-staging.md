# ADR 046: Staging on one EC2 host with Docker Compose

Date: 2026-10-30. Status: accepted.
Requirements: NFR-SEC-001, SRS 10.1, 12. Related: ADR 020 (AWS production design), ADR 021 (KMS),
ADR 043 (SMTP STARTTLS), ADR 016 (LiveKit).

## Context

Staging runs on one Ubuntu 24.04 EC2 instance (2 vCPU, 8 GiB) with Docker Engine, not the
ECS/RDS/ElastiCache design of ADR 020. It must still run the production code paths
(`NODE_ENV=production` and every check that comes with it), keep the database, cache, object
storage and virus scanner off the Internet, use LiveKit Cloud, and wrap document keys with AWS KMS.

## Decision

1. **Images:** the existing `docker/api.Dockerfile` (`api`, `migrate`) and `docker/web.Dockerfile`
   (`web`, standalone), unchanged. Containers run as a non-root user, and api and web have a
   read-only root filesystem with a tmpfs `/tmp`.
2. **`docker-compose.staging.yml`:** a Caddy proxy is the only service with host ports (80, 443,
   Let's Encrypt for three names: web, API, files). PostgreSQL and Redis sit only on an
   `internal: true` network. The API, storage and ClamAV also join the edge network for egress
   (LiveKit Cloud, KMS, HIBP, mail, Google, signature updates).
3. **Database TLS without code changes:** `docker/staging/db-tls.sh` creates a staging CA and a
   server certificate for the host name `postgres`. The API and the migrate job connect with
   `PGSSLMODE=verify-full` against that CA, the same code path as RDS's bundle (db-config.ts).
   `pg_hba.conf` accepts only `hostssl` with SCRAM. Verified locally: plaintext is rejected, an
   untrusted CA fails, and all API connections use TLS.
4. **Least privilege for secrets:** `.env.staging` (API) and `.env.staging.db` (PostgreSQL admin,
   seen only by postgres and migrate). Redis and SeaweedFS receive only their own secret.
   Redis's password goes into a config file inside the container, not onto the command line. Both
   files exist only on the server (mode 600, gitignored), with tracked `.example` templates.
5. **KMS:** `DOCUMENT_KMS_PROVIDER=aws` with two keys and the instance role. No AWS keys on disk.
   The key policy and role policy allow only `kms:Encrypt`/`kms:Decrypt`, and only with an
   `org_id` and `document_id` encryption context (`infra/staging-ec2/`). IMDSv2 uses a hop
   limit of 2 for bridged containers, and `imds-guard.sh` (DOCKER-USER rules) lets only the API's
   fixed address reach the metadata service, so the web, proxy, storage and ClamAV containers
   cannot obtain the role. *Superseded by ADR 047 (2026-10-30): a source address is not an
   identity, and the rules loaded after Docker. The guard is now its own nftables table, matched
   on the API's dedicated bridge and loaded before Docker. All containers drop their capabilities.*
6. **Mail: authenticated SMTP is allowed in production** (implemented in `mailer.ts`). Before,
   `MAIL_TRANSPORT=smtp` was refused whenever `NODE_ENV=production` ("a plaintext dev transport").
   Since ADR 043 that only describes the form without a login. Production now accepts smtp only
   when all of these hold; otherwise the API does not start, and the error names the setting,
   never its value:
   - `SMTP_USER` and `SMTP_PASSWORD` are set. With a login, `SmtpMailTransport` requires STARTTLS
     and a certificate valid for `SMTP_HOST` in the system trust store before AUTH. There is no
     plaintext fallback.
   - `SMTP_HOST` is a public host name: not an IP address, `localhost`, `*.local` or a single label.
   - The port is 587, or unset (which means 587). Port 25 (relay, optional TLS) and 465 (implicit
     TLS, not implemented) are refused.
   - `MAIL_FROM` (or `SMTP_FROM`) is a plain address. The SMTP client writes `MAIL FROM:<…>`, so a
     display name would break delivery, and line breaks are rejected.
   - `NODE_TLS_REJECT_UNAUTHORIZED` is not `0`.

   Found while testing: `tls.connect` used Node's default for `rejectUnauthorized`, so
   `NODE_TLS_REJECT_UNAUTHORIZED=0` in the environment would have switched certificate checks off
   even in development. It is now explicit (`rejectUnauthorized: true`, TLS 1.2 minimum), with a
   regression test. The test-only extra CA cannot be set from the environment, and production
   transports report `trustsExtraCa === false`. Gmail with an App Password is fine for staging. It
   is tied to one account, has daily limits and no domain SPF/DKIM for a custom sender, so a
   provider with a verified domain (Resend is still supported) is the choice past staging.
7. **SSH mode first** (`docker-compose.staging.ssh.yml`). The proxy is not started; web, API and
   storage publish on `127.0.0.1` only; testers forward 3000/3001/8333 over SSH (or Systems
   Manager) and open `http://localhost:3000`. The compose file now takes full URLs (`WEB_URL`,
   `API_URL`, `FILES_URL`) instead of host names, so one file serves both modes. Browsers treat
   http://localhost as a secure context: verified in production mode with Chromium (sign-in,
   Secure + HttpOnly + SameSite=Strict refresh cookie surviving a reload, `isSecureContext`, office
   sockets). `TRUST_PROXY` is off in this mode, so a tester cannot spoof `X-Forwarded-For`. Not
   available without a public URL: LiveKit webhooks (call attendance); e-mail links work only for
   testers with the tunnel open.
8. **Database TLS everywhere** (bug fix). `PostgresAttendanceRepository` built its own three pools
   from `PG*` without the CA. `pg` honours `PGSSLMODE` by itself, so with `verify-full` it tried TLS
   against Node's default trust store and every attendance query failed with "unable to verify the
   first certificate". The same would have happened on RDS (ADR 020). The pools now start from the
   shared `poolConfig()`, with only the login differing per role. `/health` had passed because it
   uses the Prisma service's pool; the browser test found it.

## Consequences

- Application code changed in two places: `mailer.ts` (production SMTP rules, explicit
  certificate checks) and `attendance-repository.ts` (TLS on its pools). Regression tests:
  `mailer.test.ts` (9 new), `db-connection-config.test.ts` (1 new).
- `vault-e2e` no longer fails on plaintext `_staging/` objects left in the shared test bucket by
  earlier, interrupted runs. It skips staging objects whose document no longer exists, reports how
  many, and deletes nothing. Every other object, including this run's staging objects, is still
  checked.
- Validated locally with the real Docker Compose v2.33 (`config -q`, missing-variable errors) and a
  production-mode run under podman: migrate over TLS, all 32 migrations applied, API `/health`
  db+redis ok, web served through the proxy, CORS limited to the web origin, internal ports
  unpublished, the data network without egress.
- KMS itself was not exercised (no AWS resources yet). The first document upload on the server is
  the check.
- One host means no high availability. Backups are pg_dump plus EBS snapshots (runbook).
- Minor: Prisma logs that it cannot detect OpenSSL in the slim runtime image. The engine still
  connects over TLS (startup `$connect` succeeds); installing `openssl` in the runtime stage would
  silence it.
