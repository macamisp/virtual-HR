# Restore drill (ADR 020)

**When:** monthly in staging, and before each major release. Production only with written approval.

**Who:** an operator with AWS credentials for the target account. Never an agent.

## Steps

1. Confirm the last daily backup succeeded: AWS Backup → Jobs, or no `backup-failed` alert.
2. Run `infra/scripts/restore-drill.sh --env staging` and type `staging` to confirm. The script:
   - restores the database at its latest restorable time into `hrvo-staging-drill-<time>`;
   - runs the verification task (`docker/restore-verify.mjs`). It checks that all migrations are applied, RLS is forced on every `org_id` table and the tables are populated. It reads only catalog and statistics views, never row content;
   - prints the restore point, RTO and the result, then deletes the temporary copy (`--keep` leaves it for manual inspection; delete it afterwards).
3. **Documents:** pick one test document's object in the bucket and restore an earlier version from AWS Backup to a new prefix. Open it through the app's staging copy, or check its SHA-256 against `document_versions.sha256`.
4. Record the result below. If the restore failed, or RTO is over 60 minutes or RPO over 5 minutes, open an incident.

## Targets

- **RPO** ≤ 5 minutes: point-in-time recovery, transaction logs every 5 minutes.
- **RTO** ≤ 60 minutes to a usable copy.

## Drill log

| Date | Env | Restore point | RTO (min) | Verification | By | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| | | | | | | |
