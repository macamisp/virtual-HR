# Independent encrypted database backup (ADR 051)

Applies to the single-EC2 deployment (ADR 046, `hrvo-staging-postgres-1`). For the planned RDS/AWS
Backup topology, see [restore-drill.md](restore-drill.md) (ADR 020).
Requirements: NFR-REL-002, NFR-SEC-001. **Every production step below needs the user's approval.**

## Rules

- Production is read-only here: no PostgreSQL settings, restarts, volume, Compose or AWS changes.
- Never print or copy plaintext dumps, connection strings, passwords, presigned URLs or the private key.
- The host holds only the **public** key. Decryption happens only on the workstation, into the tmpfs container.
- Keep backups outside the git repository.

## 0. One-time key setup (operator, on the workstation)

```bash
gpg --quick-gen-key "HRVO DB backup <ops@virtual-hr.site>" ed25519 sign 2y   # choose a strong passphrase
FPR=$(gpg --with-colons --list-keys "HRVO DB backup" | awk -F: '$1=="fpr"{print $10; exit}')
gpg --quick-add-key "$FPR" cv25519 encr 2y
gpg --armor --export "$FPR" > hrvo-backup-public.asc                 # public: safe to copy to the host
gpg --armor --export-secret-keys "$FPR" > /media/<offline-usb>/hrvo-backup-secret.asc   # 2 offline copies
echo "$FPR"                                                           # the fingerprint is not secret
```

If the private key or its passphrase is lost, every backup is unrecoverable. Test-decrypt from an offline
copy once.

## 1. Preflight (read-only)

SSH with `StrictHostKeyChecking=yes`, `IdentitiesOnly=yes` and the stored ED25519 key
`SHA256:eT3NNtl2T6fgBeDt3IAibin81tts1luwa0dXY1lGpoU`. Confirm via IMDSv2 that the instance ID is
`i-084a36f551ca3a72c`, and that there is at least 1 GiB free (the script checks this too).

## 2. Create the encrypted backup (host; writes only under `/home/ubuntu/hrvo-backups`)

```bash
scp hrvo-backup-public.asc scripts/db-backup/backup-encrypted.sh ubuntu@HOST:~/
ssh ubuntu@HOST 'gpg --batch --import ~/hrvo-backup-public.asc &&
  RECIPIENT_FPR=<FPR> KIND=adhoc bash ~/backup-encrypted.sh </dev/null'
```

The script prints the output directory. It contains `db.dump.gpg`, `roles.sql.gpg`, `counts.tsv`,
`migrations.tsv`, `schema.tsv`, `manifest.txt` and `SHA256SUMS` (mode 600, directory 700). Load: one
short read-only transaction; it takes about 1 s at the current 18 MB.

## 3. Off-server copy

**Workstation pull (no AWS change):**

```bash
mkdir -m 700 -p /run/media/macami/DataDrive/hrvo-backups
scp -r ubuntu@HOST:~/hrvo-backups/hrvo-<UTC>-<kind> /run/media/macami/DataDrive/hrvo-backups/
( cd /run/media/macami/DataDrive/hrvo-backups/hrvo-<UTC>-<kind> && sha256sum -c SHA256SUMS )
```

**S3 (after the bucket in ADR 051 §3 exists).** The operator creates a presigned PUT URL for each object
(15-minute expiry) and passes it privately, for example in a mode-600 file on the host, never in chat.
Then on the host:

```bash
for f in db.dump.gpg roles.sql.gpg manifest.txt SHA256SUMS counts.tsv migrations.tsv schema.tsv; do
  curl --fail -sS -T "$DIR/$f" "$(sed -n "s|^$f ||p" ~/presigned.txt)"; done; shred -u ~/presigned.txt
```

Afterwards, verify with the operator's console listing (object sizes and versions), then download and
run `sha256sum -c`.

## 4. Verify: isolated restore test (workstation)

```bash
scripts/db-backup/restore-test.sh /run/media/macami/DataDrive/hrvo-backups/hrvo-<UTC>-<kind>
```

Each step must pass: ciphertext checksums → tmpfs container with no network → roles + `pg_restore
--exit-on-error` → plaintext hashes → exact row counts → migrations → RLS/schema fingerprints →
`hrvo_app` fail-closed check. Record the `PASS` line and `restore_seconds` in the drill log below.
gpg asks for the passphrase through pinentry, so the operator runs this step, or unlocks gpg-agent first.

## 5. Retention and recovery

| Set | Frequency | Keep | S3 control |
| --- | --- | --- | --- |
| `daily/` | daily (once scheduling is approved) | 35 days | Object Lock 35 d + lifecycle expire 36 d |
| `weekly/` | Sundays | 12 months | Object Lock 365 d + lifecycle expire 366 d |
| `adhoc/` | before each deploy/migration | 90 days | lifecycle expire 90 d |
| Workstation copy | per pull | latest 5 + last weekly | manual prune (approval) |

Restore drill: quarterly, plus before any Supabase test migration (step 4). **Real recovery** (approval and
an incident only): restore into a new container or database first, verify it with step 4's checks, then
plan a write-freeze switchover. Never restore over the live database in place. RPO with daily dumps is
24 h; the SRS 5-minute RPO needs WAL archiving or managed PITR (separate decision).

## Cost (USD list prices, approximate; recheck at approval)

Size today is about 0.56 MB per backup set. Allowing growth to 5 MB, 87 retained sets total at most 0.5 GB.

| Item | Estimate |
| --- | --- |
| S3 Standard storage (about $0.025/GB-month) | < $0.01/month today; about $0.013 at 0.5 GB |
| PUT/GET requests (about 7 objects/day) | < $0.01/month |
| Transfer EC2 → S3 Melbourne (cross-region, about $0.02/GB) | < $0.01/month |
| Restore-drill download (S3 egress, within the 100 GB/month free allowance) | $0 |
| Optional customer-managed KMS key instead of SSE-S3 | about $1/month |
| Workstation pull (EC2 egress, within the free allowance) | $0 |
| Object Lock / versioning / Block Public Access | no extra charge beyond stored versions |

## Drill log

| Date (UTC) | Backup | Restore target | Result | Restore s | By | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-11-12 | local e2e DB (dry run) | tmpfs container | PASS | 1 (5.8 total) | Claude | throwaway key; not production; tamper test rejected |
