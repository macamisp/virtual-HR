# ADR 011: Administration, Custom Roles and Consent Records

**Status:** Accepted
**Date:** 16 October 2026
**Requirements:** SRS 5.11 FR-ADM-001, 002, 004, 006; 5.12 FR-AUD-004 (and FR-AUD-001 verification); 6.4 configurable parameters.

## 1. Decisions agreed with the product owner

| Topic | Decision |
| --- | --- |
| Custom roles | **Base role + overrides.** A custom role is a built-in role plus added and removed permissions. It is resolved server-side on every request, with a 30-second cache per API instance. Admins manage roles in the UI. |
| Policy scope | **Per organisation.** The attendance state machine is unchanged and is built from each org's thresholds. The failing tests were written first (`attendance-policy.test.ts`). |

## 2. Policy (FR-ADM-001)

- **Columns:** `organizations.att_*` hold the missed-heartbeat timeout, grace window, idle, pause, maximum session and paid break. The existing `manual_time_limit_minutes`, `timesheet_variance_pct` and `vault_reauth_minutes` are edited on the same screen.
- **Ranges:** SRS 6.4 ranges are enforced three times: by Zod (`OrgPolicySchema`), by `validateAttendancePolicy`, and by database CHECKs. The pause threshold must be greater than the idle threshold.
- **Global:** the heartbeat interval stays global, because it is a client protocol constant.
- **Engine:**
  - `AttendanceService.setPolicyProvider` loads the policy per org, cached for 30 s.
  - `PUT /admin/policy` invalidates the cache, so the next heartbeat uses the new values.
  - Past days are not recalculated.
- **Audit:** the change is audited as `ORG_POLICY_UPDATED`, with before and after values.

## 3. Roles and permissions (FR-ADM-002)

- **Table and assignment:**
  - Table `org_roles`: `base_role`, `added_permissions` and `removed_permissions`, with RLS forced. A trigger stops a user from being linked to another org's role.
  - `users.custom_role_id` is nullable.
  - **`users.role` always equals the custom role's base role.** Every SQL check on `u.role` (for example SUBCONTRACTOR) therefore stays correct. When a role's base changes, its users' `role` is updated in the same transaction.
- **Resolution:** `PermissionResolver`, called by the now-async `PermissionsGuard`, reads role, team, status and the custom role from the database.
  - Services check `userCan(user, perm)` against the effective set.
  - Role changes and deactivations take effect within 30 s on every instance, or at once on the instance that made the change, instead of at the next token refresh.
- **Rules (`role-rules.ts`, unit-tested):**
  - A custom role cannot be based on SUPER_ADMIN.
  - Nobody grants what they do not hold. This applies to a role's effective permissions, to editing or deleting a role, and to the target user's permissions before and after an assignment. An `x.all` permission covers `x.team`. SUPER_ADMIN is exempt.
    - **Consequence:** admins do not hold `vault.recover`, so only a super admin can appoint an HR manager.
  - SUPER_ADMIN is given and taken only by a super admin. Nobody changes their own role.
  - **2FA cannot be bypassed:**
    - 2FA-grade permissions (`org.manage`, `users.manage`, `roles.manage`, `privacy.manage`, `vault.recover`) can only be added to a base role that already requires 2FA. Login therefore always asks for 2FA when they are held.
    - Assigning a 2FA role to someone without 2FA revokes their sessions.
    - The resolver refuses any request whose role needs 2FA while 2FA is not enabled.
  - A role that still has users cannot be deleted. Otherwise its users would silently get the full base role.
  - Updates use optimistic concurrency (`version`). A stale version returns 409.
- **Audit:** every change is audited: `ROLE_CREATED`, `ROLE_UPDATED`, `ROLE_DELETED`, `USER_ROLE_CHANGED`.
- **UI:** `GET /me/access` returns the effective permissions, and the web `useCan` uses them.

## 4. Retention (FR-ADM-004)

- **Configurable:**
  - `retention_presence_days` (30–730, default 90). The monitoring notice now shows this value.
  - `retention_notifications_days` (30–1825, default 365).
  - The daily job prunes both through the `hrvo_retention` role. The app role still cannot delete notifications.
- **Documents:** these keep their per-category rules (ADR 010); the screen links to them.
- **Audit log:** kept permanently.
- **Not yet stored:** recordings and chat do not exist yet and are shown as "not available".

## 5. Audit viewer (FR-ADM-006)

- **Endpoints:** `GET /audit-logs` now takes filters (actor, action, entity type and id, from and to). It also gained `/facets`, `/export` (CSV, at most 10 000 rows, formula-safe, audited as `AUDIT_LOG_EXPORTED`) and `/verify`.
- **Verification:** `/verify` recomputes the chain in batches and returns `{ valid, checked, brokenAtId }`.
- **Resource fix:** the old service opened its own connection pools per instance; it now uses the shared Prisma pool.

## 6. Consents (FR-AUD-004)

- **Storage:** `monitoring_consents` gains `consent_type` (MONITORING, RECORDING, AI) and `granted`. The table stays append-only for the app: withdrawing adds a row with `granted = false`, and the history is never rewritten.
- **Versioning:** each record carries the notice version (`CONSENT_NOTICES`) and the server time. A decision on an outdated notice version returns 409.
- **Who sets what:**
  - Monitoring consent is still given through the attendance notice.
  - The attendance consent check now counts only granted MONITORING rows, so a RECORDING or AI consent never opens attendance tracking.
- **Routes:**
  - `GET` and `POST /me/consents`, for any user.
  - `GET /admin/users/:id/consents`, for HR or auditors.
  - Changes are audited as `CONSENT_GIVEN` and `CONSENT_WITHDRAWN`.

## 7. Migration `20261020000000_admin_roles_policy`

- Policy and retention columns with CHECKs.
- `org_roles` with RLS and the same-org trigger.
- `monitoring_consents.consent_type` and `granted`.
- `fn_list_orgs_for_jobs()` now returns the retention settings.
- `GRANT SELECT, DELETE ON notifications TO hrvo_retention`.

## 8. Tests

- `attendance-policy.test.ts` (written first).
- `role-rules.test.ts`.
- `admin-e2e.test.ts` (22 tests):
  - the permission matrix for every new route;
  - validation and database CHECKs;
  - immediate effect of policy, role and assignment changes with the same token;
  - escalation refusals and 2FA revocation;
  - RLS and cross-org 404s;
  - pruning by retention;
  - consents being append-only;
  - audit filters, CSV export, and tamper detection pointing at the broken entry.
- Playwright `12-admin.spec.ts`.

## 9. Known gaps

- The resolver cache is per instance, so another instance may apply a role change up to 30 s late. Redis pub/sub invalidation can come later.
- Custom roles cannot have their own MFA requirement; it follows the base role, as described above.
- There are no feature flags (FR-ADM-005) or branding (FR-ADM-003); both are out of scope.
- Recording and AI consents are recorded, but no feature reads them yet; those features do not exist.
- The demo now uses `REDIS_DB=1`, so its BullMQ worker no longer picks up the test suite's jobs. `REDIS_DB` is new in `.env.example`.
