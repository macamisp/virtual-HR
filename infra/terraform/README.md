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
