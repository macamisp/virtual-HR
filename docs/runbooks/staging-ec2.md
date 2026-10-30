# Staging on one AWS EC2 host (ADR 046)

One Ubuntu 24.04 instance (m7i-flex.large: 2 vCPU, 8 GiB, 60 GiB gp3) running
`docker-compose.staging.yml` in production mode: LiveKit Cloud for media, AWS KMS for document
keys, Gmail (or another provider) over authenticated STARTTLS SMTP for e-mail. The ECS/RDS design
in `infra/terraform` (ADR 020) is the production path; this is the cheaper staging path.

**Start in SSH mode** (section 3): no DNS, no reverse proxy, no Elastic IP and no web ports open.
Move to public mode (section 6) only when testers without SSH access need it.

| Service | Image | Networks | Host ports (SSH mode) | Host ports (public mode) |
|---|---|---|---|---|
| proxy (Caddy) | caddy:2.8.4-alpine | edge | not started | 80, 443 |
| web (Next.js standalone) | docker/web.Dockerfile | edge | 127.0.0.1:3000 | none |
| api (NestJS) | docker/api.Dockerfile | edge, data | 127.0.0.1:3001 | none |
| storage (SeaweedFS S3) | chrislusf/seaweedfs:4.48 | edge, data | 127.0.0.1:8333 | none |
| postgres 16 (TLS only) | postgres:16.10-alpine | data | none | none |
| redis 7 (password) | redis:7.4.6-alpine | data | none | none |
| clamav | clamav/clamav:1.4 | edge, data | none | none |
| migrate (one-off) | docker/api.Dockerfile `migrate` | data | none | none |

`data` is an internal Docker network with no route to the Internet. `127.0.0.1` ports are reachable
only from the server itself, so only through an SSH tunnel.

## 0. Costs and the Free plan (checked 2026-10-30; confirm in the Billing console)

| Item | Price (us-east-1) | Per month, running 24/7 |
|---|---|---|
| EC2 m7i-flex.large, on demand | about $0.096/hour | about $70 |
| Public IPv4 (auto-assigned, used for SSH) | $0.005/hour, in use or idle | about $3.65 |
| EBS gp3, 60 GiB | about $0.08/GiB-month | about $4.80 |
| KMS: 2 customer-managed keys | $1/key-month, prorated hourly | $2 |
| KMS rotation | +$1/key-month for each of the first two rotations (yearly), then capped | $0 in year one |
| KMS requests | 20,000/month free, then $0.03 per 10,000 | about $0 |
| IAM, instance profile, Systems Manager Session Manager | free | $0 |
| Elastic IP, DNS, load balancer | not used in SSH mode | $0 |

Total: about $80 a month for 24/7 operation. Stopping the instance outside test sessions stops the
EC2 charge and releases the auto-assigned public IPv4 (it changes at the next start); EBS is still
charged.

- **Accounts created on or after 2025-07-15 (Free plan):** m7i-flex.large is Free Tier eligible,
  but usage is paid from the $100 (+ up to $100 earned) credits. The plan ends after 6 months
  **or when the credits run out**, whichever is first. AWS then suspends the account; data is kept
  90 days, then erased, unless the account is upgraded to a Paid plan. At about $80 a month, the
  credits last roughly 1.25 to 2.5 months of 24/7 use. EC2, EBS, VPC, KMS, IAM and Systems Manager
  are all available on the Free plan; multi-Region KMS keys are not (not needed here).
- **Accounts created before 2025-07-15:** only t2.micro/t3.micro are Free Tier eligible (750
  h/month for 12 months). m7i-flex.large is billed at the rates above from the first hour.
- **Before provisioning:** in Billing, check the plan and the remaining credits, and create a
  budget alert (for example at $10 and $50). Check eligibility with
  `aws ec2 describe-instance-types --filters Name=free-tier-eligible,Values=true --query "InstanceTypes[].InstanceType"`.

## 1. AWS resources (plan; create them only when approved)

Replace `REGION`, `ACCOUNT_ID` and the key IDs. The KMS keys must be in the instance's Region.
Policy templates are in `infra/staging-ec2/`.

### 1a. IAM role and instance profile (free)

```bash
aws iam create-role --role-name hrvo-staging-ec2 --assume-role-policy-document file://infra/staging-ec2/ec2-trust-policy.json
aws iam create-instance-profile --instance-profile-name hrvo-staging-ec2
aws iam add-role-to-instance-profile --instance-profile-name hrvo-staging-ec2 --role-name hrvo-staging-ec2
aws ec2 associate-iam-instance-profile --instance-id i-XXXX --iam-instance-profile Name=hrvo-staging-ec2
# Optional, to reach the host without opening port 22: attach AmazonSSMManagedInstanceCore (section 3b).
```

### 1b. KMS: two customer-managed symmetric keys (about $2/month)

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
# Then fill the two key ARNs into iam-instance-policy.json and attach it:
aws iam put-role-policy --role-name hrvo-staging-ec2 --policy-name hrvo-staging-kms --policy-document file://iam-instance-policy.filled.json
```

The key policy names the role, so create the role first (1a). The API may only `kms:Encrypt` and
`kms:Decrypt`, and only with an `org_id` and `document_id` encryption context. That is the same
rule as the Terraform policy. Keep the 30-day deletion window: deleting a key loses every document
wrapped with it. Keys pending deletion are not charged.

### 1c. Instance settings (free)

```bash
# IMDSv2 only; hop limit 2 so a container on a Docker bridge can reach it (the host firewall in
# section 2 then lets only the API container through).
aws ec2 modify-instance-metadata-options --instance-id i-XXXX --http-tokens required --http-put-response-hop-limit 2 --http-endpoint enabled
```

- **Security group (SSH mode), inbound:** 22/tcp from your own IP only. Nothing else. With
  Session Manager (3b), no inbound rule at all.
- **EBS:** encrypted (default EBS encryption is fine).
- **Google Cloud Console:** add `http://localhost:3001/auth/google/callback` to the OAuth client
  (Google allows http://localhost redirect URIs).
- **LiveKit Cloud:** calls work in SSH mode. The webhook (attendance of room calls and meetings)
  needs a public URL, so leave it until public mode.
- **Gmail:** an App Password for the sending account (2-Step Verification on).

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
# Fill both in on the server (an editor over SSH; never a chat, ticket or commit). In SSH mode keep
# WEB_URL=http://localhost:3000, API_URL=http://localhost:3001, FILES_URL=http://localhost:8333.

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

## 3. Deploy in SSH mode

```bash
cd /opt/virtual-hr/app
git fetch origin && git checkout --detach <release commit>
C="docker compose -f docker-compose.staging.yml -f docker-compose.staging.ssh.yml --env-file .env.staging --env-file .env.staging.db"
$C config -q                      # validates; never print `config` without -q (it shows secrets)
$C build
$C up -d postgres redis storage clamav
$C run --rm migrate               # prisma migrate deploy + role passwords, over verified TLS
$C up -d
$C ps
curl -fsS http://127.0.0.1:3001/health   # {"status":"ok","db":"ok","redis":"ok"}
```

### 3a. Each tester, from their own computer

```bash
ssh -N -L 3000:127.0.0.1:3000 -L 3001:127.0.0.1:3001 -L 8333:127.0.0.1:8333 ubuntu@<instance public DNS or IP>
# then open http://localhost:3000
```

The local ports must be 3000, 3001 and 8333, because the app's addresses (CORS, cookies, upload
links) name them. Browsers treat http://localhost as a secure context: the Secure, HttpOnly,
SameSite=Strict refresh cookie, camera, microphone and screen sharing all work. This was verified
locally in production mode with Chromium. Firefox and Safari were not tested.

### 3b. Without opening port 22 (Systems Manager, free)

With the AmazonSSMManagedInstanceCore policy on the role and the Session Manager plugin installed
locally, run one port forward per port:

```bash
aws ssm start-session --target i-XXXX --document-name AWS-StartPortForwardingSession --parameters '{"portNumber":["3000"],"localPortNumber":["3000"]}'
# repeat for 3001 and 8333 in two more terminals
```

### 3c. What does not work in SSH mode

- **LiveKit webhooks** (call and meeting attendance records): LiveKit Cloud cannot reach the
  server. The calls themselves work.
- **Links in e-mails** point to http://localhost:3000. They work for a tester who has the tunnel
  open, and for nobody else.
- **Google sign-in** works once the localhost redirect URI is added.

## 4. Check it

```bash
sudo ss -ltnp | grep -E ':(5432|6379|3310)\b' || echo "databases and ClamAV: no host ports"
sudo ss -ltnp | grep -E ':(3000|3001|8333)\b'   # must show 127.0.0.1 only
sudo iptables -S DOCKER-USER | grep 169.254.169.254
docker compose -f docker-compose.staging.yml logs --since 10m api | grep -iE 'error|refuse' || true
```

Then, through the tunnel: sign up a workspace (the verification e-mail must arrive from Gmail),
sign in with 2FA, open the office, join a room call with a second account, share a screen, upload
and open a document (this exercises KMS), and sign in with Google.

## 5. Updates, rollback, backups

- **Update:** check out the new commit, then `$C build && $C run --rm migrate && $C up -d`.
  Migrations only go forward. Take a backup first.
- **Rollback:** check out the previous commit, then `$C build && $C up -d`. Only safe if no
  migration ran; otherwise restore the backup.
- **Database backup:**
  `docker compose -f docker-compose.staging.yml exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -Fc hrvo_staging' > /opt/virtual-hr/backups/hrvo-$(date -u +%F).dump`
  Keep the backups directory mode 700. EBS snapshots cost extra (about $0.05/GB-month).
- **Documents** need the KMS keys as well as the data.

## 6. Later: public mode (needs DNS)

1. An Elastic IP (about $3.65/month, idle or in use) and three DNS names pointing at it.
2. Security group: 80/tcp and 443/tcp from anywhere.
3. In `.env.staging`: `WEB_URL`, `API_URL` and `FILES_URL` as `https://` addresses, plus
   `ACME_EMAIL`.
4. Google redirect URI `https://<api>/auth/google/callback`; LiveKit webhook
   `https://<api>/media/livekit/webhook`.
5. Deploy without the SSH override:
   `docker compose -f docker-compose.staging.yml --env-file .env.staging --env-file .env.staging.db up -d`.
   Rebuild `web` first, because the URLs are compiled into it.

## Never

- Commit `.env.staging`, `.env.staging.db` or anything under `.staging/` or the secrets folder.
- Publish the database, Redis, storage or ClamAV ports, or open 3000/3001/8333 in the security
  group (SSH mode relies on them staying on 127.0.0.1).
- Set `AUTH_MFA_ENFORCEMENT=off`, `BREACHED_PASSWORD_CHECK=local`, `DOCUMENT_KMS_PROVIDER=local`,
  a KMS endpoint, `NODE_TLS_REJECT_UNAUTHORIZED=0` or an unauthenticated SMTP server. The API
  refuses them in production.
