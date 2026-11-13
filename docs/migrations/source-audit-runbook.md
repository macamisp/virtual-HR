# Read-only source audit runbook

Requirements: FR-AUTH-010, NFR-REL-002, NFR-SEC-001/003. This is a procedure pending
an established access path, not evidence that an audit has run.

1. Obtain the SSH hostname/user or existing SSM access method privately. Verify the existing
   host key; never disable host checking. Match host identity to instance `i-084a36f551ca3a72c`
   in `ap-southeast-2` using authorized read-only AWS evidence. Do not trust DNS alone.
2. Inspect running containers by Compose project/service labels. Use only selected inspect
   fields: image ID, state, labels and mounts. Do not print full `docker inspect`, `env`,
   `docker compose config`, `.env` files or process arguments: these can expose credentials.
   Verify the API's effective database host/name/user using a server-side program that emits
   only those fields, for both Prisma URL and PG* paths; never echo complete URLs/passwords.
3. Confirm `/opt/virtual-hr/app` deployed commit and compare every migration file SHA-256
   against the local manifest. Read-only queries of `_prisma_migrations` must exclude `logs`.
   Report missing, altered, failed and rolled-back migrations without attempting repair.
4. Resolve the actual postgres container and its data mount. A Compose declaration predicts
   but does not prove the actual volume name (`hrvo-staging_postgres_data` is only a candidate).
   Inspect volume mountpoint and PGDATA; map via `findmnt`/`lsblk`/NVMe volume identifiers
   to EBS. Do not run prune, down, recreate, mount changes or volume cleanup.
5. Through existing container-local access using its privately configured admin login,
   run `production-audit.sql` with `psql -X -v ON_ERROR_STOP=1 -f`.
   Precreate the output in a mode-700 encrypted directory with umask 077, redirect to a
   mode-600 file, and never paste it into chat. No network port publication is needed.
   The script is a bounded read-only repeatable-read transaction. Counts can create I/O;
   stop on timeout, assess load, and report incompleteness rather than retrying aggressively.
   Non-bypass audit roles intentionally skip exact counts to avoid misleading RLS-filtered totals.
   Missing or permission-filtered sequence last values must be reported as unknown.
6. Review schema backup function definitions and catalog role membership/grants offline for
   superuser dependencies, unsafe SECURITY DEFINER search paths, executable PUBLIC privileges,
   ownership, triggers, custom tenant functions and application-writeable trusted schemas.
   Inspect views/materialized views, partitions, enum/type dependencies, sequence ownership,
   extensions and any objects outside public before selecting migration archive entries.
7. Using an existing authorized AWS CLI/session (do not install or alter policies), collect:

   ```bash
   aws ec2 describe-instances --region ap-southeast-2 --instance-ids i-084a36f551ca3a72c \
     --query 'Reservations[].Instances[].{Id:InstanceId,State:State.Name,Root:RootDeviceName,Devices:BlockDeviceMappings}'
   ```

   For the returned volume IDs, use read-only `describe-volumes` to verify encryption,
   KMS key identity, attachment, size and state; `describe-snapshots` restricted to owned
   source volumes to verify completed snapshots. Check DeleteOnTermination per attachment,
   including root and any separate data volume. Inspect existing Backup/DLM policies,
   recovery points and restore evidence where permissions allow. Do not modify anything.
   DeleteOnTermination=true means termination would remove that volume; do not terminate
   the instance or change the flag within this task.
8. Inspect backup schedule definitions and sanitized metadata: last successful completion,
   archive sizes, checksums, filesystem permissions, encryption, retention, off-instance copy,
   restore duration and test date. Never print cron lines with credentials, archive contents,
   role password hashes or document content. An EBS snapshot schedule alone does not prove
   PostgreSQL consistency or the SRS 5-minute RPO / 2-hour RTO.

Keep raw evidence encrypted and access-restricted outside git. Publish only sanitized object
counts, privilege findings, migration comparison and backup status. Production remains read-only;
the subsequent backup/test restore and Supabase production-data copy have separate gates in
`supabase-assessment.md`. Do not execute the deployment/rollback commands from older runbooks
as part of this audit: several restart services or modify infrastructure.
