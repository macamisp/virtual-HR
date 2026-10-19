# HRVO: HR Virtual Office

A web application for small remote teams: automatic attendance (clock-in and clock-out without pressing anything), tasks and timesheets for employees and subcontractors, encrypted documents and contracts, a virtual office with meetings and chat, leave and holidays, and the audit trail an HR owner needs.

The requirements are in [docs/SRS.md](docs/SRS.md). What is built, what is partial and what is missing is in [docs/STATUS.md](docs/STATUS.md).

## Try it on your computer (about 15 minutes)

You need **Node.js 22**, **Docker or Podman with Compose**, and a phone with an authenticator app (HR accounts must use two-factor sign-in).

```bash
git clone https://github.com/macamisp/virtual-HR.git hrvo && cd hrvo
docker compose up -d                # database, Redis, document storage, virus scanner, KMS emulator, LiveKit, mail catcher
npm install
npm run setup                       # creates .env, generates the encryption keys and the database client
npm run db:migrate && npm run db:provision-roles
npm run seed:demo                   # a demo company with five people (password: DemoPassword123!)
npm run api                         # terminal 1: http://localhost:3001
npm run web                         # terminal 2: http://localhost:3000
```

Open http://localhost:3000 and sign in as `worker@acme.demo`. With Podman use `podman compose up -d`. The step-by-step guide, with what to click and what you should see, is [docs/runbooks/web-local.md](docs/runbooks/web-local.md). If a step fails, section 7 of that guide lists the usual causes.

## Check that everything works

```bash
npm run verify -- --preflight       # are the services up? (seconds)
npm run verify                      # lint, types, API tests, browser tests, one summary table (about 40 minutes)
```

`npm run verify` also prints the measured clock-in and clock-out delays (requirements NFR-ACC-001 to 004). For acceptance testing by a person, with exact clicks and expected results for each of the seven client requirements and each acceptance criterion (AC-01 to AC-16), use [docs/runbooks/uat.md](docs/runbooks/uat.md).

## Where things are

| You want to | Read |
| --- | --- |
| Accept the product (click-by-click checks) | [docs/runbooks/uat.md](docs/runbooks/uat.md) |
| Know what is not tested automatically, and what is skipped | [docs/verification/untested-and-skipped.md](docs/verification/untested-and-skipped.md) |
| Know the known problems and limits, in plain words | [docs/verification/known-issues.md](docs/verification/known-issues.md) |
| Show the product to people outside your network | [docs/runbooks/demo-internet.md](docs/runbooks/demo-internet.md) |
| Record or review meetings (recording needs extra setup) | [docs/runbooks/meeting-recording.md](docs/runbooks/meeting-recording.md) |
| See decisions and why they were made | [docs/adr/](docs/adr/) |
| See who may call which API route, and tenant isolation | [docs/security/route-permissions.md](docs/security/route-permissions.md), [docs/security/rls-coverage.md](docs/security/rls-coverage.md) |

## Layout

```
apps/api       NestJS API (PostgreSQL with row-level security, Redis, BullMQ, Socket.IO)
apps/web       Next.js web app (React, Tailwind) and the Playwright browser tests
apps/agent     optional desktop agent (Electron) for more accurate attendance
packages/shared  types and validation shared by the API and the web app
infra          Terraform (AWS), LiveKit and demo configuration
docs           requirements, decisions, runbooks, security and verification notes
```

Working rules for contributors and AI agents are in [AGENTS.md](AGENTS.md). Secrets never go in the repository: use `.env` (ignored by git); `.env.example` lists every setting.
