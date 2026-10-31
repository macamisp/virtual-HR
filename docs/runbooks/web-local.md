# Run HRVO locally and click through the web app

For the product owner and developers. Takes about 10 minutes the first time.

## What you need

- Node.js 22 and Docker (or Podman) with Compose. With Podman, type `podman compose` wherever this guide says `docker compose`. About 6 GB of free disk for the images.
- An authenticator app on your phone (Google Authenticator, Microsoft Authenticator, 1Password…) for the HR and admin accounts
- Two browser windows, one of them private/incognito, to be two people at once
- For the browser tests only: `npx playwright install chromium` (once)

Windows: use WSL 2. The commands are for a Linux or macOS shell.

## 1. Start the infrastructure (once per session)

```bash
LAN_HOST=localhost docker compose up -d  # starts the services listed below
npm install                   # first time only
npm run setup                 # first time only
npm run verify -- --preflight # shows which services answer
```

Compose currently requires `LAN_HOST` even when the optional LAN proxy profile is disabled. Use
the `LAN_HOST=localhost` prefix for the Compose commands below too. This only supplies Compose's
required value; for access from other devices, follow [lan-https.md](lan-https.md).

| Service | Port | What it is for |
| --- | --- | --- |
| Postgres | 5433 | the database |
| Redis | 6379 | background jobs, rate limits, coordination |
| storage | 9000 (this computer only) | document files, S3-compatible (SeaweedFS). Its keys are `S3_ACCESS_KEY` / `S3_SECRET_KEY` in `.env` |
| ClamAV | 3310 | virus scan of every upload. **The first start needs a few minutes to load its signatures**; uploads wait in "Scanning for viruses" until then |
| kms | 4566 | an AWS KMS look-alike, used by the tests and to try the cloud key mode |
| LiveKit | 7880 | audio and video for meetings and the office |
| Mailhog | 1025 / 8025 | catches all emails; read them at http://localhost:8025 |

`npm run setup` creates `.env` from `.env.example` if you have none, generates the two **document-encryption keys** (`DOCUMENT_KMS_LOCAL_KEY` and `DOCUMENT_KMS_RECOVERY_KEY`) and the database client. The API refuses to start without those keys, and documents cannot be opened without them: **keep your `.env`** (it is never committed). Running `npm run setup` again changes nothing that is already set.

Background jobs (task reminders, carry-over, weekly summary, attendance close) run on BullMQ in
Redis when `JOBS_ENABLED=true` (the default). Set `JOBS_ENABLED=false` to run the API without
Redis; notification emails are then sent inline and nothing is scheduled. Without jobs nothing
closes a dropped attendance session, so also set `ATTENDANCE_RECONCILE_INLINE_MS=15000` to run the
reconciler inside the API (ADR 026). Emails land in Mailhog.

Documents (ADR 009) also need `NEXT_PUBLIC_STORAGE_URL` to be the storage address the browser uploads to (the default, `http://localhost:9000`, matches the compose file). The confidential vault (ADR 010) uses the separate recovery key from `npm run setup`. Share links point at `APP_WEB_URL`.

## 2. Prepare the database (first time, or after pulling new migrations)

A fresh database:

```bash
npm run db:migrate            # Prisma Migrate (creates tables, RLS, roles)
npm run db:provision-roles    # sets hrvo_app / hrvo_retention passwords from .env
```

If your `hrvo_dev` database was created by the old `schema.sql`, see ADR 005 §1 (`prisma migrate reset` deletes data; `migrate resolve --applied 20261015000000_init` keeps it).

## 3. Seed demo people

```bash
npm run seed:demo
```

It prints the accounts (password for all: `DemoPassword123!`) and an invitation link:

| Role | Email | What they can do |
| --- | --- | --- |
| Admin | admin@acme.demo | Everything, including policy, roles and the audit log; must set up 2FA on first sign-in |
| HR | hr@acme.demo | People, leave, documents, reports; must set up 2FA on first sign-in |
| Team lead | lead@acme.demo | Live board for the Support team, approves corrections |
| Employee | worker@acme.demo | Own attendance only |
| Subcontractor | sam@acme.demo | Own attendance only |

Offline? Set `BREACHED_PASSWORD_CHECK=local` in `.env`. Otherwise new passwords are checked against Have I Been Pwned, and the check refuses passwords when it can't reach the service.

## 4. Start the API and the web app (two terminals)

```bash
npm run api                   # http://localhost:3001
npm run web                   # http://localhost:3000
```

## 5. Click through

**A. Employee: automatic clock-in (window 1)**
1. Open http://localhost:3000. You land on **Sign in**.
2. Sign in as `worker@acme.demo`. The **Attendance monitoring notice** blocks the app. Nothing is tracked yet.
3. Click **I have read and accept this notice**.
4. Within a few seconds the top bar shows **"Tracking: Active since HH:MM"**. You were clocked in by the heartbeat, with no button.
5. **My attendance**: *Today* shows Active, Idle, Break, Meeting and Net time. The weekly table shows today as *In progress*.
6. Click **Start break**. The badge changes to **"On break since HH:MM"**. Click **End break**. It returns to Active and the Break total goes up.
7. Open **What we collect** in the sidebar: the plain-language notice, what is and isn't collected, and your raw events.
8. Reload the page. You stay signed in (refresh cookie) and the badge comes back.

**B. Reconnecting state**
1. Stop the API terminal (Ctrl+C). Within seconds the badge turns amber: **"Reconnecting… tracking paused"**.
2. Start it again (`npm run api`). The badge returns to *Active* by itself.

**C. Correction request and approval**
1. As the worker, fill **Request a correction** (yesterday, 08:30–16:45, a reason) and click **Submit request**. *My correction requests* shows **Pending**.
2. In a private window, sign in as `lead@acme.demo`, accept the notice, and open **Corrections**.
3. Click **Reject** without a note: you are asked for one. Type a note and click **Approve**.
4. Back in the worker window, *My correction requests* shows **Approved** and the note (refresh the page if needed).

**D. Live board (real time)**
1. As the lead, open **Live board**. Wendy Worker shows **In**; Sam shows **Not yet in**.
2. In the worker window, click **Start break**. The lead's board changes to **On break** within a second, without reloading.
3. Use the status filter buttons and the search box. Everything is reachable with Tab / Shift+Tab / Enter.

**E. Role-based access**
1. As the worker, the sidebar has no *Live board* or *Corrections*. Typing http://localhost:3000/live shows **You don't have access**. The API also refuses (403).

**F. HR with mandatory 2FA**
1. Sign out, then sign in as `hr@acme.demo`. You are sent to **Set up two-factor authentication**; no access to the app before that.
2. Scan the QR code with your authenticator app (or type the key shown under it, or tap the `otpauth://` link on a phone), then enter the 6-digit code.
3. Save the 10 recovery codes, tick the box, and click **Continue**.
4. Sign out and in again: after the password, the app asks for the code.

**G. Forgot / reset password**
1. On the sign-in page, click **Forgot your password?** and enter `worker@acme.demo`.
2. Open Mailhog (http://localhost:8025) and click the link in the email.
3. Choose a new password. All the worker's sessions are signed out, including the worker window (it returns to sign-in with a message).

**H. Accept an invitation**
1. Open the invitation link printed by `npm run seed:demo` (in a private window).
2. Enter a name and a 12+ character password. Sign in as `newhire@acme.demo`.

## 6. Automated checks

```bash
npm run verify                # everything below, then one summary table (30 to 40 minutes)
npm run verify -- --skip=e2e  # without the browser tests (about 15 minutes)
```

`npm run verify` first checks that every service answers, because some test suites **skip themselves** when document storage or the virus scanner is missing, which would look like a pass. It then runs lint, the type checks, the API tests and the browser tests (Playwright, on ports 3101/3100, so your running copy on 3000/3001 is not disturbed), and prints passed / failed / skipped per step plus the measured clock-in and clock-out delays. Logs are written to `verify-logs/`.

The single steps, if you need them: `npm run lint`, `npm run typecheck && npm run web:typecheck`, `npm test` (API; needs the services and the environment `npm run verify` sets up), `npm run e2e` (browser).

## 7. If something goes wrong

| What you see | Why | What to do |
| --- | --- | --- |
| `docker compose up -d` fails with "address already in use" | another program uses 5433, 6379, 9000, 3310, 4566 or 7880 | stop it, or stop an old HRVO stack (`docker compose down`) |
| A container name "is already in use" | a stopped container from an older copy of this project | `docker rm <name>` for the old one, then `docker compose up -d` again |
| LiveKit exits at once with "permission denied" (Fedora, RHEL, Podman) | SELinux blocked the mounted config | already fixed in the compose file (`:z`); update your copy |
| `npm run api`: "DOCUMENT_KMS_LOCAL_KEY is required" or "@prisma/client did not initialize" | `npm run setup` was not run | `npm run setup` |
| `db:provision-roles`: "DIRECT_DATABASE_URL must be set" | an older copy of the script did not read `.env` | update; the script now reads `.env` |
| Sign-in: "Invalid 2FA code" although the code looks right | a code is accepted only during its own 30 seconds, with no tolerance; your computer's clock may be off | wait for the next code; turn on automatic time on the computer and phone |
| Uploads stay at "Scanning for viruses" | ClamAV is still loading its signatures (first start: several minutes) | wait; `docker compose logs clamav` shows progress |
| Camera or microphone is blocked on a phone or another computer | browsers allow them only on HTTPS or `http://localhost` | use `localhost` on the same computer, or see [demo-internet.md](demo-internet.md) |
| `npm run verify` stops with "a required service is missing" | something in section 1 is not running | the message names the service and the fix |
| Everything worked yesterday, now the API will not connect | the machine restarted and the containers stopped | `docker compose up -d` |

## 8. Next

- Accept the product: [uat.md](uat.md) (exact clicks for the seven client requirements and AC-01 to AC-16).
- What is not tested automatically, and what is skipped: [../verification/untested-and-skipped.md](../verification/untested-and-skipped.md).
- Known problems and limits: [../verification/known-issues.md](../verification/known-issues.md).
- Show it to people outside your network: [demo-internet.md](demo-internet.md). The seed above (`npm run seed:demo`) has one published password and **refuses to run** while any configured address is public; the internet demo has its own seed with a new random password per person each time.
