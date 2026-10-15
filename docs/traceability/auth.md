# AUTH Traceability (SRS 5.1, FR-AUTH-001..012)

Status as of 15 Oct 2026. IDs and wording follow `docs/SRS.md` §5.1 exactly.
ADR 004 §1 and §3 cite several AUTH IDs incorrectly (for example "FR-AUTH-004" for reuse
detection and "FR-AUTH-010/011" for RBAC). This table is the authoritative mapping.

**DONE**: every clause of the SRS row is implemented and tested. **PARTIAL**: some clauses are missing (listed). **MISSING**: not started.

| ID | Requirement (SRS 5.1) | Prio / Phase | Status | Implementation | Tests | Gaps |
| --- | --- | --- | --- | --- | --- | --- |
| FR-AUTH-001 | Invitation-only accounts; HR/Admin sends email invite; single-use token, 7 days | Must / P1 | PARTIAL | `apps/api/src/auth/auth.service.ts` `createInvitation`, `acceptInvitation` (atomic single-use claim) | `app-shell-e2e.test.ts` "FR-AUTH-001" | Invite is **not emailed**: the raw token is returned in the API response. Mail transport now exists (`common/mailer.ts`) but invite mail is not wired. |
| FR-AUTH-002 | Argon2id; min 12 chars; reject breached passwords (k-anonymity) | Must / P1 | DONE | `auth.service.ts` `assertPasswordAcceptable`; `auth/breached-password.ts` `HibpRangeChecker` (HIBP range API, 5-char SHA-1 prefix, `Add-Padding`, fail-closed → 503) | `auth-hardening-e2e.test.ts` "Breached-password check"; live check run manually 15 Oct 2026 | `BREACHED_PASSWORD_CHECK=local` is an offline stub used by tests/CI; refused in production. |
| FR-AUTH-003 | JWT access 15 min; rotating refresh 7 days in httpOnly, Secure, SameSite cookies; reuse detection revokes family | Must / P1 | DONE | `auth/tokens.ts`; `auth.service.ts` `refresh` (atomic rotation, `revoked_reason`), `handleRefreshReuse`; `auth.controller.ts` cookie + CSRF; socket lifecycle in `attendance/attendance.gateway.ts` | `app-shell-e2e.test.ts` §2; `auth-hardening-e2e.test.ts` "Socket lifecycle", "Security baseline"; `auth-hardening-e2e.test.ts` "Refresh token is cookie-only" | — (cookie-only since 15 Oct 2026, ADR 006 §8) |
| FR-AUTH-004 | TOTP 2FA with recovery codes; mandatory for Super Admin and HR Manager | Must / P1 | DONE | `auth.service.ts` `login`, `setup2fa`, `verifyAndEnable2fa`, `consumeRecoveryCode`; enrollment-only token (`aud=hrvo-mfa-enroll`) in `auth/tokens.ts`; `@AllowMfaEnrollment` | `app-shell-e2e.test.ts` FR-AUTH-004; `auth-hardening-e2e.test.ts` "Mandatory 2FA enrollment" | Enforced for SUPER_ADMIN, ADMIN, HR_MANAGER, HR. TOTP secret is stored **unencrypted** (PLAN.md §3.3 asks for AES-256-GCM) — follow-up. |
| FR-AUTH-005 | SSO with Google and Microsoft (OIDC), per organisation | Should / P2 | MISSING | — | — | P2. |
| FR-AUTH-006 | RBAC with permissions; fixed system roles; Super Admin may create custom roles | Must / P1 | PARTIAL | `packages/shared/src/auth/types.ts` `ROLE_PERMISSIONS`; `common/guards/permissions.guard.ts` | `app-shell-e2e.test.ts` §3 | No custom roles; permissions only for modules that exist (no `timesheet.approve`, `document.confidential.view` yet). |
| FR-AUTH-007 | Lock 15 min after 5 failed logins; CAPTCHA required; user notified by email | Must / P1 | PARTIAL | `auth.service.ts` `registerFailedAttempt` (atomic counter; 2FA failures now count) | `app-shell-e2e.test.ts` FR-AUTH-007; `auth-hardening-e2e.test.ts` (2FA failure counted) | **CAPTCHA missing. Lockout email missing.** |
| FR-AUTH-008 | Password reset: single-use email link, valid 30 min, revokes all active sessions | Must / P1 | DONE | `auth.service.ts` `requestPasswordReset`, `resetPassword`; table `password_reset_tokens` (hash only, RLS); `POST /auth/password/forgot`, `POST /auth/password/reset` | `auth-hardening-e2e.test.ts` "Password reset (FR-AUTH-008)" | Email is delivered via Mailhog (dev SMTP) or the in-memory outbox; no production mail provider yet (SES/Resend). |
| FR-AUTH-009 | Users see/revoke own sessions and devices; admins revoke a user's sessions | Should / P2 | MISSING | — (logout ends only the caller's own session family) | — | P2. |
| FR-AUTH-010 | Tenant isolation at DB layer with RLS plus application checks | Must / P1 | DONE | `prisma/migrations/20261015000000_init` (ENABLE + FORCE RLS on all tenant tables, `hrvo_app` NOBYPASSRLS); `password_reset_tokens` in `..._auth_hardening`; `common/prisma.service.ts` `runWithTenantContext` | `attendance-hardening-coverage.test.ts`, `app-shell-e2e.test.ts` §3 | — |
| FR-AUTH-011 | All login, logout, failure, 2FA and role-change events written to the audit log | Must / P1 | PARTIAL | `auth.service.ts` `recordAudit` callers: LOGIN_SUCCESS, LOGIN_FAILED, ACCOUNT_LOCKED, LOGIN_LOCKED_ATTEMPT, LOGIN_REJECTED_INACTIVE, LOGOUT, TOKEN_ROTATED, REFRESH_TOKEN_REUSE_DETECTED, REFRESH_REJECTED_INACTIVE, 2FA_CHALLENGE_ISSUED, 2FA_FAILED, 2FA_RECOVERY_CODE_USED, 2FA_ENROLLMENT_REQUIRED, 2FA_SETUP_STARTED, 2FA_VERIFY_FAILED, 2FA_ENABLED, LOGIN_SUCCESS_AFTER_2FA_ENROLLMENT, PASSWORD_RESET_REQUESTED, PASSWORD_RESET_COMPLETED | `auth-hardening-e2e.test.ts` (audit assertions in 2FA, reset, inactive-user tests) | **Role change**: no code path changes a user's role yet (no endpoint), so nothing to audit; must be added with that endpoint. **Unknown-email login failures** are not audited: there is no tenant/actor and `audit_logs.actor_id` is NOT NULL. |
| FR-AUTH-012 | Idle session timeout (default 8 h) configurable per organisation | Should / P2 | MISSING | — | — | P2. |

## Related non-AUTH items delivered in this change

| Item | Where | Tests |
| --- | --- | --- |
| Prisma Migrate as sole migration tool; `schema.sql` removed | `apps/api/prisma/migrations/*`, `prisma/scripts/provision-db-roles.ts`, `.github/workflows/ci.yml` | CI: migrate on empty Postgres + drift check |
| Browser WebCrypto heartbeat signer (FR-ATT-004/017) | `packages/shared/src/attendance/heartbeat-signer.ts` | `heartbeat-signer.test.ts` |
| Seeds refuse `NODE_ENV=production` | `apps/api/test/support/refuse-in-production.ts` | `seed-guard.test.ts` |
| Security baseline (helmet/CSP, CORS allow-list, rate limits, CSRF, cookie flags) | `common/configure-app.ts`, `common/config.ts`, `common/rate-limit.ts` | `auth-hardening-e2e.test.ts` "Security baseline", "Rate limiting" |
