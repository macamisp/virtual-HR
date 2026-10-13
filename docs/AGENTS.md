# HRVO Project Rules

## Source of truth
- Requirements are in docs/SRS.md. Read the relevant sections BEFORE coding.
- Reference requirement IDs (e.g. FR-ATT-001) in commits and PR notes.
- If the SRS is unclear or conflicts with these rules, ASK me. Do not guess.

## Stack (do not change without asking)
- Monorepo (pnpm + Turborepo): apps/web (Next.js 14, TypeScript, Tailwind, shadcn/ui),
  apps/api (NestJS, Prisma, PostgreSQL 16, Redis, BullMQ, Socket.IO),
  packages/shared (types + Zod schemas).
- Real-time media: LiveKit. Files: S3-compatible storage + KMS envelope encryption.
- TypeScript strict mode everywhere. No `any`.

## Security rules (mandatory)
- Every business table has org_id and a PostgreSQL Row-Level Security policy.
- Every route has a permission guard. Validate all input with Zod/class-validator.
- Passwords: Argon2id. Never log secrets, tokens, passwords or document content.
- No secrets in code; use .env and .env.example only.
- Attendance times come from the SERVER clock only (UTC). Ignore client timestamps.
- Never add a new npm package without asking me first.

## Workflow
- Work in small slices. One slice = migration + API + UI + tests + docs.
- For attendance state machine and crypto: write failing tests FIRST.
- After each slice: run lint, typecheck, tests, then show me a demo script I can follow.
- Commit after every working slice with a clear message. Never rewrite git history.
- Write decisions in docs/adr/NNN-title.md.

## Safety
- Ask before running destructive commands (rm -rf, DROP, force push).
- Use Docker Compose for local Postgres/Redis/MinIO/ClamAV. Never touch real cloud resources without asking.

## Definition of Done
Tests pass, lint and types clean, RLS + permission tests exist for new tables/routes,
audit log written for sensitive actions, loading/empty/error UI states done.
