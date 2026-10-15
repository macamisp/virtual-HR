# ADR 004: Application Shell, Multi-Tenant Authentication, RBAC, and Real-Time Gateway

**Status:** Accepted  
**Date:** 15 October 2026  
**Context:** [`docs/SRS.md`](file:///run/media/macami/DataDrive/Hr%20virtual%20office/docs/SRS.md) Sections 3, 4, 5.1 (`FR-AUTH-001` through `FR-AUTH-011`), 8.3, 8.4, and [`AGENTS.md`](file:///run/media/macami/DataDrive/Hr%20virtual%20office/AGENTS.md).

---

## 1. Context & Motivation

Following the implementation and mathematical verification of the attendance domain engine (`FR-ATT-001..010`, `FR-ATT-013..020`), the platform requires a production-grade application shell that wraps the domain logic without modifying its core state machine.

Key requirements:
1. **NestJS Modular Architecture (`apps/api`):** Structured domain separation across `auth`, `users`, `attendance`, and `audit` modules.
2. **Enterprise Authentication (`FR-AUTH-001..011`):**
   - Invitation-only signup with 7-day token expiration (`FR-AUTH-001`).
   - Argon2id password hashing with complexity and breach checks (`FR-AUTH-002`).
   - Short-lived JWT access tokens (15 minutes) and rotating refresh tokens (7 days) in `httpOnly` cookies (`FR-AUTH-003`).
   - Refresh token reuse detection with immediate family revocation (`FR-AUTH-004`).
   - Time-based One-Time Password (TOTP) 2FA, enforced mandatorily for `ADMIN` and `HR` roles (`FR-AUTH-006`).
   - Account lockout after 5 consecutive failed login attempts for 15 minutes (`FR-AUTH-007`).
   - Session termination and per-device revocation (`FR-AUTH-008`).
   - Role-Based Access Control (RBAC) with fine-grained permissions guards on every route (`FR-AUTH-010`, `FR-AUTH-011`).
3. **Multi-Tenancy & Row-Level Security (RLS):**
   - Non-superuser `hrvo_app` execution with PostgreSQL `FORCE ROW LEVEL SECURITY` on all tenant tables.
   - Enforcing `SET LOCAL app.org_id = $1` inside an isolated transaction for every repository operation.
   - Secure resolution of tenant context during unauthenticated pre-auth operations (login, signup, refresh).
4. **Real-Time WebSocket Presence Gateway (Socket.IO):**
   - Authenticated handshake on connection; unauthenticated or malformed connections rejected.
   - Per-session HMAC secret issuance at authentication time (`FR-ATT-001..005`).
   - `presence:heartbeat` ingestion forwarding directly to `AttendanceService`.
   - Real-time broadcasts (`presence:update` to org room and `attendance:event` to user).
5. **REST API & Compliance:**
   - REST endpoints for live presence board (`GET /attendance/live`), employee transparency events (`GET /attendance/me/events`), corrections workflow (`POST /attendance/corrections`, `PATCH /attendance/corrections/:id`), and sanitized data exports (`GET /attendance/export`).
   - Tamper-evident SHA-256 audit log hash chain with serialized concurrent writes.

---

## 2. Approved Dependencies

All dependencies align with the approved stack in `AGENTS.md` and explicit user approvals:
- **`@nestjs/core`, `@nestjs/common`, `@nestjs/platform-express` (`^12.1.3`):** Web application framework.
- **`@nestjs/websockets`, `@nestjs/platform-socket.io`, `socket.io` (`^4.8.4`):** Real-time gateway.
- **`@prisma/client`, `prisma` (`^6.19.3`):** Data model definition and type client.
- **`argon2` (`^0.45.1`):** Memory-hard password hashing (Argon2id).
- **`otplib` (`^13.5.0`):** RFC 6238 TOTP two-factor authentication.
- **`jsonwebtoken` (`^9.0.3`):** Cryptographic signing and verification of access tokens.
- **`cookie-parser` (`^1.4.7`):** Secure cookie extraction for refresh tokens.
- **`zod` (`^4.6.7`):** Runtime DTO validation across REST and WebSocket payloads.
- **`date-fns`, `date-fns-tz`:** Timezone arithmetic for shift and midnight boundaries.
- **`exceljs` (`^4.4.0`):** XLSX report generation.
- **`pg` (`^8.23.1`):** Direct pooled PostgreSQL client with transaction support.

---

## 3. Decisions & Implementation Details

### 3.1 Unauthenticated Pre-Auth Lookup vs PostgreSQL Row-Level Security
- **The Challenge:** When `FORCE ROW LEVEL SECURITY` is enabled and `app.org_id` is empty (prior to authenticating a request), PostgreSQL returns zero rows from `users`, `invitations`, and `auth_sessions`.
- **Decision:** Implement three focused PostgreSQL `SECURITY DEFINER` functions in `schema.sql`:
  - `fn_lookup_user_for_auth(p_email)`: Returns public user credentials (`id`, `org_id`, `password_hash`, `role`, `totp_secret`, `failed_attempts`, `locked_until`) to evaluate authentication.
  - `fn_lookup_invitation_for_signup(p_token_hash)`: Looks up pending invitations by token hash to identify the target tenant.
  - `fn_lookup_session_for_refresh(p_token_hash)`: Resolves session family and tenant ID from refresh token hash.
- **Security Boundary:** These functions expose minimal necessary fields strictly by indexed cryptographic hash or email. Once the tenant `org_id` is identified, all subsequent data operations (session creation, audit logging, user updates) are executed strictly inside `runWithTenantContext(orgId, tx => ...)` using `SET LOCAL app.org_id = $1`.

### 3.2 JWT and Rotating Refresh Token Lifecycle (`FR-AUTH-003`, `FR-AUTH-004`)
- **Access Tokens:** Signed with HMAC-SHA256, carrying `{ sub: userId, orgId, role, sessionId }` with a 15-minute TTL.
- **Refresh Tokens:** High-entropy random bytes (32 bytes / 256 bits) stored in PostgreSQL only as SHA-256 hashes. Delivered in an `httpOnly`, `Secure`, `SameSite=Strict` cookie (`hrvo_refresh_token`).
- **Reuse Detection & Family Revocation:**
  - Each login creates a `family_id` (UUID).
  - Every refresh rotation issues a new token hash and invalidates the previous token (`is_revoked = true`, `replaced_by_token_hash = <newHash>`).
  - If a revoked refresh token is presented, the system flags a replay attack, immediately revokes all tokens belonging to that `family_id`, logs an alert in `audit_logs`, and rejects the request.

### 3.3 Two-Factor Authentication (TOTP) & Brute-Force Lockout (`FR-AUTH-006`, `FR-AUTH-007`)
- **2FA Enforcement:** Mandatory for `ADMIN` and `HR` roles. Non-admin users can optionally enroll.
- **Challenge Flow:** If 2FA is enabled, primary authentication without a TOTP code returns `{ requires2fa: true, message: 'Two-factor authentication code required' }` (or `{ requires2faSetup: true }` if unconfigured for mandatory roles). Submitting the 6-digit TOTP code with credentials to `/auth/login` (or verifying via `/auth/2fa/verify` during initial setup) issues access and refresh tokens.
- **Account Lockout:** Failed password or 2FA attempts increment `failed_attempts`. Upon reaching 5 consecutive failures, `locked_until` is set to `server_time + 15 minutes`. Further login attempts are rejected with `423 Locked`.

### 3.4 Role-Based Access Control (RBAC) Architecture (`FR-AUTH-010`, `FR-AUTH-011`)
- **Permissions Enum & Matrix:** Concrete granular permissions (`ATTENDANCE_READ_LIVE`, `ATTENDANCE_EXPORT`, `USERS_INVITE`, `CORRECTIONS_REVIEW`, etc.) defined in `packages/shared/src/auth/types.ts`.
- **Guards:**
  - `JwtAuthGuard`: Extracts Bearer token, validates signature/expiration, attaches `req.user`.
  - `PermissionsGuard`: Reads `@RequirePermissions(...)` metadata and verifies user permissions via `hasPermission(user.role, requiredPermissions)`.

### 3.5 Real-Time WebSocket Presence Gateway (`FR-ATT-001..005`)
- **Authentication Handshake:** The gateway intercepts `handleConnection` and extracts JWT from `handshake.auth.token` or `handshake.headers.authorization`. Sockets failing validation are immediately disconnected (`socket.disconnect(true)`).
- **Session HMAC Secret:** Upon login, a cryptographically random 32-byte session HMAC secret is generated and returned to the client. Heartbeats signed with this secret are validated by `HeartbeatValidator` and ingested into `AttendanceService`.
- **Room Subscriptions & Events:**
  - Connected sockets join room `org:<org_id>` and `user:<user_id>`.
  - When heartbeats transition user presence, the gateway broadcasts `presence:update` to `org:<org_id>` and emits `attendance:event` to the client.

### 3.6 Concurrency-Safe Audit Log Chaining
- Audit logs maintain an unbroken SHA-256 hash chain: `hash = SHA256(prev_hash + canonical_json(payload) + org_id + timestamp)`.
- Concurrent transactions serialize chain writes per organization using PostgreSQL advisory locks: `pg_advisory_xact_lock(hashtext('audit_logs:' || org_id))`.
- Append-only immutability is enforced by revoking `UPDATE`, `DELETE`, and `TRUNCATE` from `hrvo_app`.

---

## 4. Consequences & Verification

- **Positive:**
  - Total isolation of tenant data at the PostgreSQL engine level (`FORCE ROW LEVEL SECURITY`).
  - Zero modification to existing attendance domain algorithms (`attendance.service.ts`, `attendance-state-machine.ts`).
  - Robust protection against credential stuffing, token replay, and unauthorized multi-tenant data access.
- **Verification:**
  - Validated by 125/125 passing tests in `npm test`, including end-to-end suite `apps/api/test/app-shell-e2e.test.ts`.
  - Verified across 15 distinct scenario tests covering auth lockout, TOTP 2FA, invitation signup, token family revocation, cross-tenant RLS isolation, socket authentication, heartbeat session creation, live board, and audit hash chaining.
