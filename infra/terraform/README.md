# HRVO infrastructure (Terraform) — ADR 020

**Nothing here has been applied.** `plan` and `apply` are run only by an operator, with the owner's explicit approval (AGENTS.md).

```
bootstrap/          once per account: encrypted, versioned S3 state bucket (S3-native locking)
modules/platform/   everything else (VPC, RDS, ElastiCache, S3, KMS, Secrets Manager, ECS, ALB, Cloudflare, alarms, backups)
envs/staging/       staging account, sizes for staging
envs/production/    production account, Multi-AZ everywhere; owns the zone-wide Cloudflare settings
```

## First deployment (operator)

1. In each account: `cd bootstrap && terraform init && terraform apply -var aws_account_id=… -var env=staging`.
2. Copy `envs/<env>/backend.hcl.example` to `backend.hcl` and `<env>.tfvars.example` to `<env>.tfvars`, and fill them in (no secrets go in these files).
3. Export `CLOUDFLARE_API_TOKEN` (DNS edit and zone settings on the one zone) and AWS credentials for that account.
4. Build and push the images to the ECR repositories printed by the first apply:
   - `api:<sha>` (`--target api`);
   - `api:<sha>-migrate` (`--target migrate`);
   - `web:<sha>` (with the environment's `NEXT_PUBLIC_*` build args).
5. `terraform init -backend-config=backend.hcl && terraform plan -var-file=<env>.tfvars`. Review it, then apply.
6. Fill the external secrets listed in the `secrets_to_fill` output (LiveKit key and secret, SMTP), confirm the SNS alert e-mails, run the `migrate` task, then let the services start.
7. Run the restore drill (`docs/runbooks/restore-drill.md`) once to prove backups work.

## Each release

Push the new images, run the `migrate` task with the new tag, then `terraform apply` with `image_tag=<sha>`. ECS rolls the services with a circuit breaker and rollback.

## Checks

The CI job `terraform` runs `fmt -check` and `validate` with no backend and no credentials.

## Database conflict retries (ADR 038)

There is **no metrics package** in the API yet (adding one needs the owner's approval). The signal
for a transaction that Postgres aborted with a deadlock or serialization failure, and that the API
retried, is a single JSON log line, plus an in-process counter (`conflictRetryStats()`) used by the
tests:

```
{"event":"db_conflict_retry","op":"attendance.saveSession","kind":"deadlock","code":"40P01","attempt":1,"maxAttempts":3}
```

The line carries no parameters, tokens or personal data. Each retry is normal on its own; a steady
stream means a lock-order regression. At the first production deployment, add a log metric filter
and an alarm next to `api_errors` in `modules/platform/monitoring.tf`, for example:

```hcl
resource "aws_cloudwatch_log_metric_filter" "db_conflict_retries" {
  for_each       = toset(["api", "realtime"])
  name           = "${local.name}-${each.key}-db-conflict-retries"
  log_group_name = aws_cloudwatch_log_group.app[each.key].name
  pattern        = "{ $.event = \"db_conflict_retry\" }"
  metric_transformation {
    name      = "DbConflictRetries"
    namespace = "HRVO/${var.env}"
    value     = "1"
  }
}
# Alarm: Sum of DbConflictRetries >= 10 in 5 minutes -> aws_sns_topic.alerts (same topic as the others).
```

Also alarm on `{ $.event = "attendance_drain_timeout" }` (a shutdown that did not finish its
attendance writes within 5 s; any occurrence is worth a look). Until that is in place, search the
API log group for `db_conflict_retry` after each release.
