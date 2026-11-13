# ADR 051: Independent, client-side encrypted PostgreSQL backups for the single-EC2 deployment

Date: 2026-11-12. Status: **proposed**. The scripts are built and dry-run locally. No production backup, off-server
copy or AWS resource exists yet; each needs approval.
Requirements: NFR-REL-002, NFR-SEC-001, FR-AUTH-010; SRS backup policy (WAL/PITR, 35 daily, 12 months weekly,
cross-region, RPO 5 min, RTO 2 h, quarterly drills).
Related: ADR 020 (planned RDS/AWS Backup topology; not what runs today), ADR 046 (single-EC2 staging),
ADR 047 (IMDS isolation), [source audit](../migrations/source-audit-2026-11-12.md).

## Context

The live database (PostgreSQL 16.10, 18 MB, 84 tables) runs in Docker on instance `i-084a36f551ca3a72c`.
Its only disk is the root EBS volume `vol-0755d13e47a5de04f`, and DeleteOnTermination is unverified.
The only backups are two manual, **plaintext** dumps from 2026-11-04/05 on that same volume. Nothing is
scheduled, nothing is copied off the host, and `archive_mode=off`. Losing the volume or terminating the
instance would lose the database and every backup together. The Supabase assessment also needs a verified
independent backup before any test migration.

Constraints: no new npm packages, no PostgreSQL/volume/configuration changes, and no AWS changes without
approval. The host has no aws CLI, and its instance role is deliberately unused (ADR 047). The workstation
disks are **not** encrypted (ext4/btrfs, no LUKS).

## Decision

1. **Consistent logical dump.** `scripts/db-backup/backup-encrypted.sh` opens one REPEATABLE READ READ ONLY
   transaction and exports its snapshot. `pg_dump -Fc --snapshot=` and the row-count, migration and RLS
   baseline all read that same snapshot, so the restored copy must match the baseline exactly. Roles are
   dumped separately with `pg_dumpall --roles-only --no-role-passwords`, so no password hashes are included.
   Only existing tools are used: `pg_dump` 16.10 in the container, plus gpg 2.4 and coreutils on the host.
2. **Client-side public-key encryption.** The dump streams straight into `gpg --encrypt` for one pinned
   recipient fingerprint (Curve25519 subkey, AES-256), so plaintext never reaches the host's disk. The host
   holds the **public key only**. The private key, with a passphrase, lives on the operator workstation, plus
   two offline copies. A stolen host, bucket or laptop disk exposes ciphertext only. SHA-256 is recorded for
   both the ciphertext (`SHA256SUMS`) and the plaintext (`manifest.txt`).
3. **Off-server destinations (both proposed; neither created).**
   - **Primary:** a new S3 bucket in **ap-southeast-4 (Melbourne)**. That is a different region from the
     instance, which gives the cross-region copy, and data stays in Australia. Settings: Block Public Access,
     versioning, **Object Lock** (governance mode; 35 days for `daily/`, 365 days for `weekly/`), lifecycle
     expiry to match, SSE-S3 at rest on top of gpg, and a bucket policy that denies non-TLS requests.
     Uploads use a **short-lived presigned PUT URL** that the operator generates, so the host gets no AWS credentials.
   - **Interim/secondary:** an SSH pull of the ciphertext to the workstation, outside the repository
     (`/run/media/macami/DataDrive/hrvo-backups`). It costs nothing and needs no AWS change, but it is one
     unencrypted laptop disk, so it does not count as the durable copy on its own.
4. **Restore verification.** `scripts/db-backup/restore-test.sh` checks the ciphertext checksums first, then
   restores into a throwaway `postgres:16.10-alpine` container with `--network none` and its data on
   **tmpfs**, using a unique bootstrap superuser. It decrypts as a stream, fails on the first restore error,
   and then requires all of these to match the snapshot baseline exactly: plaintext hashes, every table's row
   count, the migration names/checksums and the schema fingerprints (forced-RLS tables, policies, definer
   functions, triggers, indexes). It also checks that `hrvo_app` with no tenant context sees zero `users`.
   It reports the restore duration as RTO evidence.
5. **Out of scope here.** Scheduling (a systemd timer on the host), WAL archiving/PITR for the 5-minute RPO,
   SeaweedFS object backups and KMS key recovery. Each is a separate change with its own approval. A daily
   dump gives a 24-hour RPO.

## Consequences

- Backups stop sharing a fate with the instance once an off-server copy exists. Losing the private key
  makes every backup unreadable, so the offline key copies are mandatory before the first production run.
- The existing plaintext dumps on the host stay as they are. Deleting them is a separate operator decision.
- Cost is negligible at the current size (see the runbook): well under USD 0.10/month for S3 with SSE-S3, or
  about USD 1/month more with a customer-managed KMS key.
- Dry run on 2026-11-12 against the local e2e database: backup in 0.8 s, isolated restore PASS in about 6 s.
  A tampered ciphertext was rejected before decryption.
