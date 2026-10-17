# Runbook: switching on meeting recording (ADR 024)

Recording stays off unless both steps below are done. Never run them against a real account without the owner's approval.

## AWS (once per environment)

1. Set `recording_enabled = true` in `envs/<env>/<env>.tfvars`. Run `terraform plan`, review it, and apply it with approval.
2. In IAM, open the user `hrvo-<env>-recording-egress` (Terraform output `recording_egress_user`) and create one access key.
3. Put the key ID into the secret `hrvo-<env>/recording-s3-access-key`. Put the secret key into `hrvo-<env>/recording-s3-secret-key`. Do not save the key anywhere else.
4. Redeploy the API service so the tasks read the new secrets.
5. **Rotation:** create a second key, update both secrets, redeploy, then delete the old key.

## In the application

1. As an admin, go to **Admin → Data retention**.
2. Tick **Allow meeting recording**.
3. Set **Meeting recordings (days)**. The default is 90.

## Local development

```sh
docker compose --profile recording up -d   # adds the LiveKit Egress container (~1.3 GB)
```

LiveKit uses the compose Redis (database 5) to reach Egress. Recordings upload to the local S3 with the `S3_*` keys.

## Checks

- **Egress health:** the Egress health port is 9091 (`curl localhost:9091`).
- **Stuck recording:** if a recording stays in "Saving", look in the API logs for `Recording processing failed`. The 5-minute `recording-maintenance` job retries it.
