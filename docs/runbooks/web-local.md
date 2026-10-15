# Run HRVO locally and click through the web app

For the product owner and developers. Takes about 10 minutes the first time.

## What you need

- Node.js 22, Docker (or Podman) with Compose
- An authenticator app on your phone (Google Authenticator, Microsoft Authenticator, 1Password…) for the HR account
- Two browser windows, one of them private/incognito, to be two people at once

## 1. Start the infrastructure (once per session)

```bash
docker compose up -d          # Postgres :5433, Redis, MinIO, ClamAV, Mailhog (http://localhost:8025)
cp -n .env.example .env       # first time only
npm install                   # first time only
```

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
| HR | hr@acme.demo | Everything; must set up 2FA on first sign-in |
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
2. Add the shown key to your authenticator app (or use the `otpauth://` link on a phone) and enter the 6-digit code.
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
npm run typecheck && npm run web:typecheck
npm test                      # API unit + e2e (needs Postgres)
npm run e2e                   # Playwright: builds the API and web, runs on ports 3101/3100
```

The first `npm run e2e` needs `npx playwright install chromium` (inside `apps/web`).
