# ADR 006: Web App (apps/web), In-Memory Session, Heartbeat Web Worker

**Status:** Accepted
**Date:** 15 October 2026
**Requirements:** SRS 4.1, 5.1, 5.5, 8.1, 8.2, 8.3, 8.4; FR-AUTH-001..004, 008; FR-ATT-001..005, 007, 013, 015, 016, 020; FR-AUD-004.

## 1. Stack and repository layout

- **Next.js 15.5.28 + React 19.3.1 instead of Next.js 14.** 14.2.35 is the last 14.x release and carries unpatched advisories: 2 critical (RCE via the image optimizer with AVIF; RCE on Windows hosts) and about 10 high (Server Components / Server Actions DoS, SSRF). Fixes exist only from 15.5.24. Approved by the product owner on 15 Oct 2026; `AGENTS.md` updated. The image optimizer is disabled anyway (`images.unoptimized`).
- Approved dependencies (exact-pinned): `@tanstack/react-query` 5.104.2, `zustand` 5.0.15, `zod` 4.6.7, `socket.io-client` 4.8.4, `tailwindcss` 3.4.19 (+ `postcss`, `autoprefixer`, `tailwindcss-animate`), the shadcn/ui helpers `class-variance-authority`, `clsx`, `tailwind-merge`, `@radix-ui/react-slot`, `@radix-ui/react-label`, `lucide-react`, and `@playwright/test` 1.64.1. shadcn components are vendored in `apps/web/src/components/ui`.
- **npm workspaces** (`apps/web`, `packages/shared` as `@hrvo/shared`) rather than pnpm + Turborepo. The API stays the root package. A pnpm/Turborepo migration remains a separate decision.
- The root `tsconfig.json` excludes `apps/web`; the web app has its own (`moduleResolution: bundler`). `@hrvo/shared` is transpiled by Next (`transpilePackages`).
- No linter: ESLint was not approved, so `next build` skips linting (`eslint.ignoreDuringBuilds`).

## 2. API contract additions (SRS 8.3)

| Route | Purpose | Permission |
| --- | --- | --- |
| `GET /attendance/me/today` | State, `trackingSince`, `onBreakSince`, today's totals as of now (server clock) | attendance.read.own |
| `GET /attendance/me/days?from&to` | Per-day totals, first in / last out, flags (≤ 62 days) | attendance.read.own |
| `GET /attendance/me/corrections` | Caller's own correction requests | attendance.corrections.create |
| `GET /attendance/consent` | Whether the current monitoring notice is accepted | authenticated |
| `POST /attendance/break/start`, `/break/end` | FR-ATT-007; pushes `presence:update` / `attendance:event` | attendance.read.own |
| `GET /attendance/corrections` | Review queue, same scope rule as approving | attendance.corrections.review |

- Response shapes are Zod schemas in `packages/shared/src/attendance/api.ts` and `auth/api.ts`. The web app validates every response against them.
- `GET /attendance/live` now requires `attendance.read.team` and scopes by permission (`read.all` → org-wide, `read.team` → own team). Before, HR_MANAGER and SUPER_ADMIN were rejected, and employees got a 500 instead of a 403. The board gained `hasClockedInToday`, which tells "signed out" from "not yet in".
- Review authorisation uses permissions (`read.all` + `corrections.review`) instead of a hard-coded HR/ADMIN list.
- Domain errors from the framework-free attendance service are mapped to 403/404/409/400 in the controller instead of surfacing as 500.
- **State-machine fix (test-first):** ending a break while not on break used to add the closed ACTIVE segment's duration to `breakSeconds`, and starting a break twice opened a second break segment. `handleUserStartsBreak` / `handleUserEndsBreak` now throw `InvalidTransitionError` (HTTP 409). Tests: `attendance-break-guard.test.ts`.

### 2.1 Bugs found by running the real browser end to end (all fixed, test-first)

| Bug | Effect | Fix | Test |
| --- | --- | --- | --- |
| Nothing resumed a DISCONNECTED session (SRS 6.2 "reconnect within 120 s → previous state") | After any socket drop or reload, the user stayed "disconnected" until the reconciler clocked them out | A valid signed heartbeat while DISCONNECTED applies `handleSocketReconnect` first | `attendance-reconnect.test.ts` |
| Any one socket closing started the grace window | Closing a second tab marked a still-connected user DISCONNECTED | The gateway starts the grace window only when the user's last socket leaves; it now also passes `orgId` (it relied on an in-process cache) | `attendance-self-service-e2e.test.ts` |
| Read-modify-write races on the session row | A slow disconnect (or the reconciler) overwrote a newer heartbeat: lost counters, wrong state | Per-user async lock around every session mutation; the reconciler re-reads inside the lock. **Single API instance only**; scaling out needs a shared lock (Postgres advisory lock / Redis) | `attendance-reconnect.test.ts` (deterministic interleaving) |
| `presence_events` never written | FR-ATT-020 "view your own raw events" was always empty | One `HEARTBEAT` event (counters only) per accepted heartbeat | `attendance-self-service-e2e.test.ts` |
| Heartbeat IP not passed | Every session recorded `127.0.0.1` | Gateway passes the handshake address | — |
| New correction omitted `reviewerId/reviewedAt/reviewNote` | Response did not match the contract (the web showed "unexpected response") | Explicit `null`s; the API test now validates the body with the shared schema | `attendance-self-service-e2e.test.ts` |
| Sequence numbers restarted per worker | A reload within the same second was rejected ("Sequence violation") | The last sequence number is persisted per device (localStorage); one retry above the server's last-seen value | Playwright `02-clock-in-heartbeat` (reload) |

## 3. Session handling in the browser

- The access token, session id and heartbeat secret live **only in memory** (a Zustand store, no persistence). Every API call sends `Authorization: Bearer`. Cookies are never used for access tokens.
- A reload restores the session via the httpOnly `refreshToken` cookie (`POST /auth/refresh` with `X-HRVO-CSRF: 1`, `credentials: 'include'`). The web app ignores the `refreshToken` field in JSON bodies.
- Refresh is **single-flight per tab and serialised across tabs with a Web Lock** (`hrvo-auth-refresh`). Refresh tokens rotate, and two tabs presenting the same cookie at once would trip reuse detection and revoke the family. A refresh is scheduled 60 s before `exp`, and any 401 triggers one refresh-and-retry.
- Mandatory 2FA: the login response's `enrollmentToken` is kept in memory and used only by `/2fa/setup`. Completing verification returns the full session.
- Invitation and reset tokens are read from the URL fragment (`#token=`) and then removed from the address bar.
- `returnTo` only accepts same-app relative paths (no open redirect).
- Security headers from `next.config.mjs`: CSP (`default-src 'self'`, `connect-src` limited to the API origin, `frame-ancestors 'none'`, `object-src 'none'`), nosniff, `Referrer-Policy: no-referrer`, X-Frame-Options DENY, Permissions-Policy. `script-src` still needs `'unsafe-inline'` for Next's inline bootstrap scripts. Moving to nonces is a follow-up.

## 4. Heartbeat client (FR-ATT-001..004)

- A **dedicated Web Worker** (`src/heartbeat/heartbeat.worker.ts`) owns the Socket.IO connection. Worker timers are not throttled like background-tab timers, so the 30 s cadence holds while the tab is hidden.
- Payload: counters only. These are active/idle seconds, `tabVisible`, `windowFocused`, `inCall` (always false until meetings exist), and `deviceId`, `sessionId`, `sequenceNumber`, `nonce`, `signature`. The main thread tells the worker only *that* input happened (a timestamp, throttled to one per 5 s), never what was typed or clicked. A Playwright test asserts the exact key set on the wire.
- **Active seconds** = the part of the interval within 60 s of the last input (reading without moving the mouse still counts). Any activity rounds up to ≥1 s so the first heartbeat after sign-in clocks the user in immediately (FR-ATT-001).
- Signing: WebCrypto HMAC-SHA256 from `@hrvo/shared/heartbeat-signer` (parity-tested against the Node validator).
- `deviceId` is stable per browser (localStorage; not a secret). `sequenceNumber` = max(previous + 1, last persisted for this device, epoch seconds), so it stays monotonic across reloads and fits the int4 column.
- **One sender per browser:** tabs elect a leader with a Web Lock (`hrvo-heartbeat-leader`). Every tab still keeps a socket for live updates. Without this, a second tab would double-count or hit sequence violations.
- **Reconnect and refresh:** socket.io reconnects with backoff (1–10 s) and reads the latest token on every attempt. On `auth:expired` / `Unauthorized` the worker asks the main thread to refresh. New credentials are applied with `auth:refresh` (or a reconnect). On `auth:revoked` the user is signed out with a reason.
- The worker starts only after the monitoring notice is accepted. The consent gate blocks the whole app until then.
- Tracking badge (SRS 8.2): "Tracking: Active since 09:02", "Idle", "On break since", "Not clocked in", and "Reconnecting… tracking paused" (amber, `role=status`, `aria-live=polite`).

## 5. Accessibility and UI states

Every screen has loading (skeleton with a screen-reader label), empty and error (with retry) states. The app has a skip link, landmarks, an `aria-current` nav, labelled inputs with `aria-describedby` errors, `aria-pressed` filters, live regions for status changes, visible focus rings, and light/dark themes (`prefers-color-scheme`).

## 6. Tests

Playwright (`apps/web/e2e`) runs the real API (port 3101; login/refresh/heartbeat rate limits raised because the suite signs the same people in repeatedly) and a production web build (port 3100) against Postgres:
- login with forced TOTP enrolment and TOTP sign-in;
- notice gate, then automatic clock-in via the signed heartbeat (checked in the DB), session restored after reload;
- heartbeat payload contains counters only;
- the reconnecting state appears after a dropped socket and recovers on its own;
- break start/end;
- a correction requested by a worker and approved by their lead with a note;
- role-based access (an employee is denied the live board and the queue in the UI) and the lead's board updating in real time.

## 7. Known gaps / follow-ups

- Times are shown in the browser's timezone. The org timezone (SRS 2.5) is not exposed by the API yet.
- No QR code for TOTP enrolment (manual key + `otpauth://` link): a QR library was not approved.
- No i18n framework yet (SRS 8.2). The office map as home screen is P2.
- The live-board team filter is limited to the caller's scope (no teams API yet). The PDF export (FR-ATT-019) isn't in the UI.
- CSP nonces; ESLint; pnpm/Turborepo.
- Remaining `npm audit` items: Next's bundled build-time `postcss@8.4.31` (processes only our own CSS), `prisma`/`deepmerge-ts` (CLI), `exceljs`/`uuid` (API, pre-existing).
