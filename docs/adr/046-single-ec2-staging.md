# ADR 046: Staging on one EC2 host with Docker Compose

Date: 2026-10-30. Status: accepted (compose, images, TLS, KMS plan); proposed (SMTP in production).
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
   cannot obtain the role.
6. **Mail:** staging uses `resend` today, which works with the current code. Gmail SMTP stays in
   development and on the Internet demo.

## Proposed: authenticated SMTP in production (not implemented; needs approval)

`createMailTransport` refuses `MAIL_TRANSPORT=smtp` whenever `NODE_ENV=production`. The reason was
true before ADR 043 ("a plaintext dev transport"). It no longer holds when `SMTP_USER` and
`SMTP_PASSWORD` are set: `SmtpMailTransport` then requires STARTTLS, verifies the certificate and
host name (`rejectUnauthorized` default, SNI), and sends AUTH only over TLS. The extra CA is a
constructor option that only tests use; no environment variable can set it.

Proposed change in `apps/api/src/common/mailer.ts`, smtp branch, production only:
- refuse when `SMTP_USER`/`SMTP_PASSWORD` are missing (no unauthenticated, plaintext relay);
- refuse when `SMTP_HOST` is unset (no `localhost` default) or `MAIL_FROM` is unset;
- refuse port 25 (servers there commonly allow opportunistic or no TLS); allow 587 (STARTTLS);
- otherwise build the same `SmtpMailTransport` as today. TLS checks and certificate
  verification are unchanged.

Tests to add (`mailer.test.ts`): production + smtp without credentials refused; with credentials
accepted; missing host or sender refused; port 25 refused; the existing "server without STARTTLS
is refused before AUTH" and "untrusted certificate is refused" tests stay. Update
`docs/runbooks/mail.md` and ADR 043.

Trade-off: Gmail with an App Password is tied to one personal account, has daily sending limits
and no domain-level SPF/DKIM for a custom sender. Resend, or another provider with a verified
domain, remains the recommendation for anything past staging.

## Consequences

- No application code changed for staging. The compose file, Caddyfile, `pg_hba.conf`, certificate
  script, IMDS guard, policy templates and runbook are new.
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
