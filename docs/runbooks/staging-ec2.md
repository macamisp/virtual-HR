# Staging on one AWS EC2 host (ADR 046)

One Ubuntu 24.04 instance (m7i-flex.large: 2 vCPU, 8 GiB, 60 GiB gp3) running
`docker-compose.staging.yml`. Production-mode containers, LiveKit Cloud for media, AWS KMS for
document keys. The ECS/RDS design in `infra/terraform` (ADR 020) is the production path; this is
the cheaper staging path.

| Service | Image | Networks | Host ports |
|---|---|---|---|
| proxy (Caddy, Let's Encrypt) | caddy:2.8.4-alpine | edge | **80, 443** (the only ones) |
| web (Next.js standalone) | built from docker/web.Dockerfile | edge | none |
| api (NestJS) | built from docker/api.Dockerfile | edge, data | none |
| migrate (one-off) | docker/api.Dockerfile `migrate` | data | none |
| postgres 16 (TLS only, SCRAM) | postgres:16.10-alpine | data | none |
| redis 7 (password) | redis:7.4.6-alpine | data | none |
| storage (SeaweedFS S3) | chrislusf/seaweedfs:4.48 | edge, data | none (public via proxy) |
| clamav | clamav/clamav:1.4 | edge, data | none |

`data` is an internal Docker network: no route to the Internet. Browsers reach storage only through
`https://FILES_HOST` with presigned URLs.

## 1. AWS resources (plan; create them only when approved)

Replace `REGION`, `ACCOUNT_ID` and the key IDs. Policy templates are in `infra/staging-ec2/`.

### 1a. KMS: two customer-managed symmetric keys (ADR 021)

```bash
for k in documents recovery; do
  sed 's/ACCOUNT_ID/<account id>/g' infra/staging-ec2/kms-key-policy.json > /tmp/kms-policy.json
  id=$(aws kms create-key --region REGION --description "hrvo-staging $k" \
        --key-usage ENCRYPT_DECRYPT --key-spec SYMMETRIC_DEFAULT \
        --policy file:///tmp/kms-policy.json --query KeyMetadata.KeyId --output text)
  aws kms enable-key-rotation --region REGION --key-id "$id"
  aws kms create-alias --region REGION --alias-name "alias/hrvo-staging-$k" --target-key-id "$id"
  echo "$k: $id"
done
```

The key policy names the role `hrvo-staging-ec2`, so create the role (1b) first. The API may only
`kms:Encrypt` and `kms:Decrypt`, and only with an `org_id` and `document_id` encryption context.
That is the same rule as the Terraform policy. Keep the deletion window at 30 days: losing a key
loses every document.

### 1b. IAM role and instance profile

```bash
aws iam create-role --role-name hrvo-staging-ec2 --assume-role-policy-document file://infra/staging-ec2/ec2-trust-policy.json
# After 1a, with the two key ARNs filled in:
aws iam put-role-policy --role-name hrvo-staging-ec2 --policy-name hrvo-staging-kms --policy-document file://iam-instance-policy.filled.json
aws iam create-instance-profile --instance-profile-name hrvo-staging-ec2
aws iam add-role-to-instance-profile --instance-profile-name hrvo-staging-ec2 --role-name hrvo-staging-ec2
aws ec2 associate-iam-instance-profile --instance-id i-XXXX --iam-instance-profile Name=hrvo-staging-ec2
# Optional, to manage the host without SSH: attach AmazonSSMManagedInstanceCore.
```

No AWS access keys go into `.env.staging`. The SDK in the API container uses the instance role.

### 1c. Instance settings

```bash
# IMDSv2 only; hop limit 2 so a container on a Docker bridge can reach it (the host firewall in
# section 2 then lets only the API container through).
aws ec2 modify-instance-metadata-options --instance-id i-XXXX --http-tokens required --http-put-response-hop-limit 2 --http-endpoint enabled
```

- **Security group, inbound:** 22/tcp from your own IP only (or none, with SSM), 80/tcp and
  443/tcp from anywhere. Nothing else.
- **Elastic IP** on the instance. **EBS** encrypted (default EBS encryption is fine).
- **DNS:** A records for `WEB_HOST`, `API_HOST` and `FILES_HOST` pointing at the Elastic IP.
  They must resolve before the first start, or Let's Encrypt fails.
- **Google Cloud Console:** add the OAuth redirect URI `https://API_HOST/auth/google/callback`
  (and `https://API_HOST/calendar/oauth/callback` for calendar sync).
- **LiveKit Cloud:** set the webhook URL to `https://API_HOST/media/livekit/webhook`.
- **E-mail:** a Resend sending domain, or the approved SMTP change (ADR 046).

## 2. Server preparation (once)

```bash
sudo sysctl -w vm.overcommit_memory=1 && echo 'vm.overcommit_memory = 1' | sudo tee /etc/sysctl.d/90-redis.conf
# 2 GiB swap as a cushion for ClamAV signature reloads.
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile && echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

sudo install -d -m 700 -o "$USER" /opt/virtual-hr/secrets
cd /opt/virtual-hr/app
bash docker/staging/db-tls.sh /opt/virtual-hr/secrets/db-tls
# Move /opt/virtual-hr/secrets/db-tls/ca.key off the server (it only signs new server certificates).

cp .env.staging.example .env.staging && chmod 600 .env.staging
cp .env.staging.db.example .env.staging.db && chmod 600 .env.staging.db
# Fill both in (an editor on the server, never a chat or a ticket).

# Instance-metadata guard, re-applied whenever Docker starts.
sudo install -m 755 infra/staging-ec2/imds-guard.sh /usr/local/sbin/hrvo-imds-guard
sudo tee /etc/systemd/system/hrvo-imds-guard.service >/dev/null <<'UNIT'
[Unit]
Description=Only the HRVO API container may reach the EC2 metadata service
After=docker.service
Requires=docker.service
PartOf=docker.service
[Service]
Type=oneshot
Environment=API_EDGE_IP=172.30.0.10
ExecStart=/usr/local/sbin/hrvo-imds-guard
[Install]
WantedBy=docker.service
UNIT
sudo systemctl daemon-reload && sudo systemctl enable --now hrvo-imds-guard
```

## 3. Deploy a release

```bash
cd /opt/virtual-hr/app
git fetch origin && git checkout --detach <release commit or tag>
C="docker compose -f docker-compose.staging.yml --env-file .env.staging --env-file .env.staging.db"
$C config -q                      # validates; do not print `config` without -q (it shows secrets)
$C build
$C up -d postgres redis storage clamav
$C run --rm migrate               # prisma migrate deploy + role passwords, over verified TLS
$C up -d
$C ps
```

The first ClamAV start downloads signatures (a few minutes). Uploads are scanned once it is ready.

## 4. Check it

```bash
curl -fsS https://API_HOST/health          # {"status":"ok","db":"ok","redis":"ok"}
curl -fsSI https://WEB_HOST/login | head -1
sudo ss -ltnp | grep -E ':(5432|6379|8333|3310|3000|3001)\b' || echo "no internal ports on the host"
sudo iptables -S DOCKER-USER | grep 169.254.169.254
docker compose -f docker-compose.staging.yml logs --since 10m api | grep -iE 'error|refuse' || true
```

Then, in a browser: sign up a workspace (the e-mail must arrive), sign in with 2FA, open the
office, join a room call with a second account, share a screen, upload and open a document (this
exercises KMS), and sign in with Google.

## 5. Updates, rollback, backups

- **Update:** check out the new commit, then `$C build && $C run --rm migrate && $C up -d`.
  Migrations only go forward. Take a backup first.
- **Rollback:** check out the previous commit, then `$C build && $C up -d`. Only safe if no
  migration ran; otherwise restore the backup.
- **Database backup:**
  `docker compose -f docker-compose.staging.yml exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -Fc hrvo_staging' > /opt/virtual-hr/backups/hrvo-$(date -u +%F).dump`
  Keep the backups directory mode 700.
- **Volumes:** EBS snapshots (Data Lifecycle Manager, daily) cover Postgres, SeaweedFS and Caddy's
  certificates.
- **Documents** need the KMS keys as well as the data. Keep the key deletion window at 30 days.

## Never

- Commit `.env.staging`, `.env.staging.db` or anything under `.staging/` or the secrets folder.
- Publish the database, Redis, storage or ClamAV ports, or open them in the security group.
- Set `AUTH_MFA_ENFORCEMENT=off`, `BREACHED_PASSWORD_CHECK=local`, `DOCUMENT_KMS_PROVIDER=local`
  or a KMS endpoint. The API refuses them in production anyway.
